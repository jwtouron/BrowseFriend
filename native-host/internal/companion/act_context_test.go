package companion

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

type contextClient struct {
	Client
	stream func(context.Context, ModelOptions, func(string)) ([]object, error)
}

func (f contextClient) Stream(ctx context.Context, o ModelOptions, delta func(string)) ([]object, error) {
	return f.stream(ctx, o, delta)
}
func (f contextClient) SignOut(context.Context) (Session, error) {
	return Session{State: "signed_out"}, nil
}
func contextCall(id string) object {
	return object{"type": "function_call", "id": "fc_" + id, "call_id": id, "namespace": "browsefriend", "name": "page_click", "arguments": `{"ref":"e1"}`}
}
func contextParams() object {
	return object{"conversationId": "conversation-1", "model": "model-1", "history": []any{}, "mode": "act", "prompt": "Read both files", "pageContext": `{"text":"First observation"}`, "reasoningEffort": "medium"}
}
func continueParams(call string) object {
	p := contextParams()
	p["pageContext"] = `{"text":"New observation"}`
	p["continuation"] = object{"callId": call, "name": "page_click", "arguments": `{"ref":"e1"}`, "output": `{"ok":true}`}
	return p
}
func contextHarness(t *testing.T, stream func(context.Context, ModelOptions, func(string)) ([]object, error)) (*Handler, func(string, object) object) {
	t.Helper()
	replies := make(chan object, 100)
	h := NewHandler(contextClient{stream: stream}, func(v any) { replies <- v.(map[string]any) })
	t.Cleanup(h.Close)
	run := func(id string, p object) object {
		h.model(Request{ID: id, Method: "model.stream", Params: p})
		for {
			r := <-replies
			if r["id"] == id {
				b, _ := json.Marshal(r)
				if strings.Contains(string(b), "synthetic-opaque") {
					t.Fatal("opaque context crossed native boundary")
				}
				return r
			}
		}
	}
	return h, run
}
func TestActContextPreservesChronologyAndClearsCompletion(t *testing.T) {
	var inputs [][]object
	n := 0
	reasoning := object{"type": "reasoning", "id": "rs_1", "encrypted_content": "synthetic-opaque", "summary": []any{}}
	message := object{"type": "message", "role": "assistant", "content": []any{object{"type": "output_text", "text": "Inspecting files"}}}
	h, run := contextHarness(t, func(_ context.Context, o ModelOptions, _ func(string)) ([]object, error) {
		b, _ := json.Marshal(o.Input)
		var input []object
		json.Unmarshal(b, &input)
		inputs = append(inputs, input)
		n++
		if n == 1 {
			return []object{reasoning, message, contextCall("one")}, nil
		}
		if n == 2 {
			return []object{contextCall("two")}, nil
		}
		return []object{message}, nil
	})
	if run("task", contextParams())["ok"] != true {
		t.Fatal("first step")
	}
	if run("task", continueParams("one"))["ok"] != true {
		t.Fatal("second step")
	}
	if run("task", continueParams("two"))["ok"] != true || h.actTask != nil {
		t.Fatal("completion retained task")
	}
	got := inputs[2]
	types := []string{}
	for _, v := range got {
		if v["type"] != nil {
			types = append(types, text(v["type"]))
		}
	}
	if !reflect.DeepEqual(types, []string{"reasoning", "message", "function_call", "function_call_output", "function_call", "function_call_output"}) {
		t.Fatal(types)
	}
	b, _ := json.Marshal(got)
	s := string(b)
	if !strings.Contains(s, "First observation") || !strings.Contains(s, "New observation") || !strings.Contains(s, "synthetic-opaque") || strings.Count(s, "Read both files") != 1 {
		t.Fatal("lost or duplicated context", s)
	}
	if !reflect.DeepEqual(got[2], reasoning) || !reflect.DeepEqual(got[3], message) {
		t.Fatal("canonical output changed")
	}
	run("new-task", contextParams())
	b, _ = json.Marshal(inputs[3])
	if strings.Contains(string(b), "synthetic-opaque") || strings.Contains(string(b), "New observation") {
		t.Fatal("context leaked to next task")
	}
}
func TestActContinuationValidation(t *testing.T) {
	for _, kind := range []string{"missing", "wrong-id", "wrong-conversation", "wrong-model", "wrong-effort", "wrong-prompt", "wrong-call", "wrong-args", "wrong-name", "invalid-result", "invalid-page", "duplicate"} {
		t.Run(kind, func(t *testing.T) {
			h, run := contextHarness(t, func(context.Context, ModelOptions, func(string)) ([]object, error) {
				return []object{contextCall("one")}, nil
			})
			if kind != "missing" {
				run("task", contextParams())
			}
			p := continueParams("one")
			id := "task"
			switch kind {
			case "wrong-id":
				id = "other"
			case "wrong-model":
				p["model"] = "other"
			case "wrong-conversation":
				p["conversationId"] = "other"
			case "wrong-effort":
				p["reasoningEffort"] = "low"
			case "wrong-prompt":
				p["prompt"] = "other"
			case "wrong-call":
				p["continuation"].(object)["callId"] = "other"
			case "wrong-args":
				p["continuation"].(object)["arguments"] = `{"ref":"e2"}`
			case "wrong-name":
				p["continuation"].(object)["name"] = "page_submit"
			case "invalid-result":
				p["continuation"].(object)["output"] = "invalid"
			case "invalid-page":
				p["pageContext"] = "invalid"
			case "duplicate":
				p = contextParams()
			}
			reply := run(id, p)
			if reply["ok"] != false || reply["error"].(*Error).Code != "act_context_lost" {
				t.Fatal(reply)
			}
			if id == "task" && h.actTask != nil {
				t.Fatal("failed task retained context")
			}
		})
	}
}
func TestActContextCancellationAndAccountChanges(t *testing.T) {
	for _, event := range []string{"cancel", "logout", "close", "ask"} {
		t.Run(event, func(t *testing.T) {
			h, run := contextHarness(t, func(context.Context, ModelOptions, func(string)) ([]object, error) {
				return []object{contextCall("one")}, nil
			})
			run("old", contextParams())
			run("new", contextParams())
			h.Dispatch(context.Background(), Request{ID: "late", Method: "model.cancel", Params: object{"requestId": "old"}})
			if h.actTask == nil || h.actTask.id != "new" {
				t.Fatal("late cancellation cleared newer task")
			}
			switch event {
			case "cancel":
				h.Dispatch(context.Background(), Request{ID: "stop", Method: "model.cancel", Params: object{"requestId": "new"}})
			case "logout":
				h.auth(Request{ID: "logout", Method: "auth.signOut"})
			case "close":
				h.Close()
			case "ask":
				p := contextParams()
				p["mode"] = "ask"
				run("ask", p)
			}
			if h.actTask != nil {
				t.Fatal("terminal event retained context")
			}
		})
	}
}
func TestActContextCancelledCompletionCannotReviveBuffer(t *testing.T) {
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	h, _ := contextHarness(t, func(context.Context, ModelOptions, func(string)) ([]object, error) {
		close(entered)
		<-release
		return []object{contextCall("late")}, nil
	})
	go func() { h.model(Request{ID: "task", Method: "model.stream", Params: contextParams()}); close(done) }()
	<-entered
	h.Dispatch(context.Background(), Request{ID: "stop", Method: "model.cancel", Params: object{"requestId": "task"}})
	close(release)
	<-done
	if h.actTask != nil {
		t.Fatal("cancelled completion revived context")
	}
}
func TestActContextBoundAndMalformedOutput(t *testing.T) {
	h, run := contextHarness(t, func(context.Context, ModelOptions, func(string)) ([]object, error) {
		return []object{contextCall("one")}, nil
	})
	run("task", contextParams())
	h.actTask.bytes = contract.Limits.ActContextBytes
	reply := run("task", continueParams("one"))
	if reply["error"].(*Error).Code != "act_context_limit" || h.actTask != nil {
		t.Fatal(reply)
	}
	for _, output := range [][]object{{{"type": "unknown"}}, {{"type": "function_call", "name": "page_click", "arguments": "{}"}}} {
		if _, err := responseCalls(output); err == nil {
			t.Fatal("malformed output accepted")
		}
	}
}
func TestSSEPreservesOpaqueItemsInOrder(t *testing.T) {
	items := []object{{"type": "reasoning", "encrypted_content": "synthetic-opaque", "summary": []any{}}, {"type": "message", "role": "assistant", "content": []any{}}, contextCall("one")}
	var s strings.Builder
	for _, item := range items {
		b, _ := json.Marshal(object{"type": "response.output_item.done", "item": item})
		s.WriteString("data: " + string(b) + "\n\n")
	}
	s.WriteString("data: {\"type\":\"response.completed\"}\n\n")
	output, err := consumeSSE(context.Background(), strings.NewReader(s.String()), func(string) {}, "")
	if err != nil || !reflect.DeepEqual(output, items) {
		t.Fatal(output, err)
	}
}

func TestActContextRejectsReplayedResult(t *testing.T) {
	n := 0
	h, run := contextHarness(t, func(context.Context, ModelOptions, func(string)) ([]object, error) {
		n++
		if n == 1 {
			return []object{contextCall("one")}, nil
		}
		return []object{contextCall("two")}, nil
	})
	run("task", contextParams())
	run("task", continueParams("one"))
	reply := run("task", continueParams("one"))
	if reply["ok"] != false || h.actTask != nil {
		t.Fatal("replayed result accepted", reply)
	}
}

func TestSSEOversizedAndMalformedCanonicalOutput(t *testing.T) {
	for _, kind := range []string{"limit", "malformed"} {
		t.Run(kind, func(t *testing.T) {
			item := object{"type": "reasoning", "encrypted_content": strings.Repeat("x", 400000)}
			if kind == "malformed" {
				item = object{"type": "unknown"}
			}
			b, _ := json.Marshal(object{"type": "response.output_item.done", "item": item})
			input := strings.Repeat("data: "+string(b)+"\n\n", 22) + "data: {\"type\":\"response.completed\"}\n\n"
			_, err := consumeSSE(context.Background(), strings.NewReader(input), func(string) {}, "")
			if err == nil {
				t.Fatal("unsafe output accepted")
			}
			if kind == "limit" && publicError(err).Code != "act_context_limit" {
				t.Fatal(err)
			}
		})
	}
}
