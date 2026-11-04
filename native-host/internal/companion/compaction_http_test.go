package companion

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func checkpointEvent(item object) string {
	b, _ := json.Marshal(object{"type": "response.output_item.done", "item": item})
	return "data: " + string(b) + "\n\n"
}
func TestCompactionUsesStreamingResponsesAndRetainsOnlyLatestCheckpoint(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	prior := object{"type": "compaction", "encrypted_content": "earlier-checkpoint"}
	input := []object{prior, {"role": "user", "content": "Earlier requirement"}, {"role": "assistant", "content": "Earlier answer"}}
	original := ModelOptions{Model: "model-1", Input: input, Instructions: "Do not use this as checkpoint policy", Tools: contract.Tools}
	var requests atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path != "/v1/responses" || r.Method != "POST" {
			t.Error("unsupported endpoint", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer synthetic-access" {
			t.Error("wrong bearer")
		}
		var body object
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid body")
		}
		if body["store"] != false || body["stream"] != true || body["instructions"] != contract.BaseInstructions || body["tools"] != nil {
			t.Error("checkpoint gained state, instructions or tools", body)
		}
		want := []any{object{"type": "compaction", "compact_threshold": float64(contract.Limits.CompactionThresholdTokens)}}
		if !reflect.DeepEqual(body["context_management"], want) {
			t.Error("missing in-band compaction", body)
		}
		b, _ := json.Marshal(input)
		got, _ := json.Marshal(body["input"])
		if string(got) != string(b) {
			t.Error("history changed")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, checkpointEvent(object{"type": "compaction", "encrypted_content": "first-checkpoint"}))
		io.WriteString(w, checkpointEvent(object{"type": "reasoning", "encrypted_content": "incidental-reasoning"}))
		io.WriteString(w, checkpointEvent(object{"type": "compaction", "encrypted_content": "latest-checkpoint"}))
		io.WriteString(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"incidental answer\"}\n\n")
		io.WriteString(w, checkpointEvent(object{"type": "message", "role": "assistant", "content": []any{object{"type": "output_text", "text": "incidental answer"}}}))
		io.WriteString(w, "data: {\"type\":\"response.completed\"}\n\n")
	}))
	defer server.Close()
	f.c.api = server.URL + "/v1"
	f.c.HTTP = server.Client()
	value, err := f.c.Compact(context.Background(), original)
	if err != nil {
		t.Fatal(err)
	}
	if value != `[{"encrypted_content":"latest-checkpoint","type":"compaction"}]` {
		t.Fatal("incorrect checkpoint", value)
	}
	if requests.Load() != 1 || original.Instructions != "Do not use this as checkpoint policy" || len(original.Tools) == 0 {
		t.Fatal("mutated caller options or repeated request")
	}
}
func TestCompactionRequiresCompleteValidCheckpoint(t *testing.T) {
	for _, kind := range []string{"small-prefix", "malformed", "oversized", "failed", "incomplete", "tool", "ordinary-stream"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			f.login(t)
			item := object{"type": "compaction", "encrypted_content": "synthetic-checkpoint"}
			finish := "data: {\"type\":\"response.completed\"}\n\n"
			expected := "invalid_compaction"
			switch kind {
			case "small-prefix":
				item = object{"type": "message", "role": "assistant"}
				expected = "compaction_not_needed"
			case "malformed":
				item["encrypted_content"] = ""
			case "oversized":
				item["encrypted_content"] = strings.Repeat("x", contract.Limits.CompactionBytes)
			case "failed":
				finish = "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"server_error\"}}}\n\n"
				expected = "server_error"
			case "incomplete":
				finish = "data: {\"type\":\"response.incomplete\"}\n\n"
				expected = "response_incomplete"
			case "tool":
				item = contextCall("forbidden")
				expected = "invalid_stream"
			case "ordinary-stream":
				expected = "invalid_stream"
			}
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, checkpointEvent(item)+finish)
			}))
			defer server.Close()
			f.c.api = server.URL
			f.c.HTTP = server.Client()
			var err error
			if kind == "ordinary-stream" {
				_, err = f.c.Stream(context.Background(), ModelOptions{Model: "model-1"}, func(string) {})
			} else {
				_, err = f.c.Compact(context.Background(), ModelOptions{Model: "model-1"})
			}
			if publicError(err).Code != expected {
				t.Fatal("incorrect recovery", err)
			}
		})
	}
}
