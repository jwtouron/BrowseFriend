package companion

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

const syntheticCompact = `[{"type":"compaction","encrypted_content":"synthetic-opaque"}]`

type transcriptClient struct {
	Client
	compact func(context.Context, ModelOptions) (string, error)
	stream  func(context.Context, ModelOptions, func(string)) ([]object, error)
}

func (c *transcriptClient) Compact(ctx context.Context, o ModelOptions) (string, error) {
	return c.compact(ctx, o)
}
func (c *transcriptClient) Stream(ctx context.Context, o ModelOptions, d func(string)) ([]object, error) {
	return c.stream(ctx, o, d)
}
func (c *transcriptClient) Status(context.Context) (Session, error) {
	return Session{State: "signed_out"}, nil
}
func (c *transcriptClient) SignIn(context.Context, bool) (Session, error) {
	return Session{State: "signed_in"}, nil
}
func (c *transcriptClient) SignOut(context.Context) (Session, error) {
	return Session{State: "signed_out"}, nil
}
func transcriptHarness(t *testing.T) (*Handler, *transcriptClient, func(string, string, object) object) {
	t.Helper()
	replies := make(chan object, 100)
	client := &transcriptClient{compact: func(context.Context, ModelOptions) (string, error) { return syntheticCompact, nil }, stream: func(context.Context, ModelOptions, func(string)) ([]object, error) { return nil, nil }}
	h := NewHandler(client, func(v any) { replies <- v.(object) })
	t.Cleanup(h.Close)
	call := func(id, method string, p object) object {
		r := Request{ID: id, Method: method, Params: p}
		if method == "model.context.clear" {
			h.Dispatch(context.Background(), r)
		} else {
			h.Dispatch(context.Background(), r)
		}
		for {
			reply := <-replies
			if reply["id"] == id {
				return reply
			}
		}
	}
	return h, client, call
}
func transcriptParams() object {
	return object{"conversationId": "chat-1", "model": "model-1", "history": []any{}}
}
func transcriptStream(handle string) object {
	p := transcriptParams()
	p["prompt"] = "Read page"
	p["pageContext"] = "{}"
	p["contextHandle"] = handle
	return p
}
func cacheHandle(t *testing.T, r object) string {
	t.Helper()
	if r["ok"] != true {
		t.Fatal(r)
	}
	data, _ := json.Marshal(r)
	if strings.Contains(string(data), "synthetic-opaque") {
		t.Fatal("opaque context leaked", string(data))
	}
	result := r["result"].(object)
	if result["contextBytes"] != len(syntheticCompact) {
		t.Fatal(result)
	}
	return result["contextHandle"].(string)
}
func assertCode(t *testing.T, r object, code string) {
	t.Helper()
	if r["ok"] != false || r["error"].(*Error).Code != code {
		t.Fatal(r)
	}
}

func TestTranscriptCacheRetainsCanonicalItemsAndPriorCompaction(t *testing.T) {
	h, c, call := transcriptHarness(t)
	handle := cacheHandle(t, call("compact", "model.compact", transcriptParams()))
	c.stream = func(_ context.Context, o ModelOptions, _ func(string)) ([]object, error) {
		if o.Input[0]["type"] != "compaction" || o.Input[0]["encrypted_content"] != "synthetic-opaque" {
			t.Fatal(o.Input)
		}
		return nil, nil
	}
	if call("stream", "model.stream", transcriptStream(handle))["ok"] != true {
		t.Fatal("stream failed")
	}
	c.compact = func(_ context.Context, o ModelOptions) (string, error) {
		if o.Input[0]["encrypted_content"] != "synthetic-opaque" {
			t.Fatal("prior compaction missing")
		}
		return syntheticCompact, nil
	}
	p := transcriptParams()
	p["contextHandle"] = handle
	successor := cacheHandle(t, call("again", "model.compact", p))
	if successor == handle || h.transcript.handle != successor {
		t.Fatal("handle not rotated")
	}
	assertCode(t, call("old", "model.stream", transcriptStream(handle)), "model_context_lost")
}
func TestTranscriptLostScopeAndClearFailBeforeProvider(t *testing.T) {
	h, c, call := transcriptHarness(t)
	handle := cacheHandle(t, call("compact", "model.compact", transcriptParams()))
	providerCalls := 0
	c.stream = func(context.Context, ModelOptions, func(string)) ([]object, error) { providerCalls++; return nil, nil }
	for _, kind := range []string{"missing", "conversation", "model"} {
		p := transcriptStream(handle)
		switch kind {
		case "missing":
			p["contextHandle"] = "missing"
		case "conversation":
			p["conversationId"] = "other"
		case "model":
			p["model"] = "other"
		}
		assertCode(t, call(kind, "model.stream", p), "model_context_lost")
	}
	if providerCalls != 0 {
		t.Fatal("expired context sent to provider")
	}
	call("clear-old", "model.context.clear", object{"conversationId": "old-chat"})
	if h.transcript == nil {
		t.Fatal("stale clear discarded current context")
	}
	call("clear", "model.context.clear", object{"conversationId": "chat-1"})
	assertCode(t, call("cleared", "model.stream", transcriptStream(handle)), "model_context_lost")
	if providerCalls != 0 {
		t.Fatal("cleared context sent")
	}
	p := transcriptStream(handle)
	delete(p, "contextHandle")
	if call("raw", "model.stream", p)["ok"] != true || providerCalls != 1 {
		t.Fatal("raw fallback failed")
	}
}
func TestTranscriptInvalidatesOnModelConversationAuthAndExit(t *testing.T) {
	for _, event := range []string{"model", "conversation", "auth", "sign-in", "sign-out", "exit"} {
		t.Run(event, func(t *testing.T) {
			h, _, call := transcriptHarness(t)
			cacheHandle(t, call("compact", "model.compact", transcriptParams()))
			p := transcriptStream("")
			delete(p, "contextHandle")
			switch event {
			case "model":
				p["model"] = "other"
				call("new", "model.stream", p)
			case "conversation":
				p["conversationId"] = "other"
				call("new", "model.stream", p)
			case "auth":
				h.AuthChanged(Session{State: "signed_out"})
			case "sign-in":
				h.auth(Request{ID: "login", Method: "auth.signIn"})
			case "sign-out":
				h.auth(Request{ID: "logout", Method: "auth.signOut"})
			case "exit":
				h.Close()
			}
			if h.transcript != nil {
				t.Fatal("retained invalid context")
			}
		})
	}
}
func TestTranscriptFailedAndCancelledReplacementPreservesPrior(t *testing.T) {
	for _, kind := range []string{"unsupported", "not-needed", "malformed", "oversized", "cancelled", "clear", "auth"} {
		t.Run(kind, func(t *testing.T) {
			h, c, call := transcriptHarness(t)
			handle := cacheHandle(t, call("first", "model.compact", transcriptParams()))
			p := transcriptParams()
			p["contextHandle"] = handle
			c.compact = func(context.Context, ModelOptions) (string, error) {
				switch kind {
				case "unsupported":
					return "", failure("unsupported_method", "unsupported", false)
				case "not-needed":
					return "", failure("compaction_not_needed", "Prefix below threshold", false)
				case "malformed":
					return `[{"type":"message"}]`, nil
				case "oversized":
					return strings.Replace(syntheticCompact, "synthetic-opaque", strings.Repeat("x", contract.Limits.CompactionBytes), 1), nil
				case "cancelled":
					h.Dispatch(context.Background(), Request{ID: "cancel", Method: "model.cancel", Params: object{"requestId": "replace"}})
				case "clear":
					h.Dispatch(context.Background(), Request{ID: "clear", Method: "model.context.clear", Params: object{"conversationId": "chat-1"}})
				case "auth":
					h.AuthChanged(Session{State: "signed_out"})
				}
				return syntheticCompact, nil
			}
			r := call("replace", "model.compact", p)
			if r["ok"] != false {
				t.Fatal("failed replacement succeeded", r)
			}
			if kind == "clear" || kind == "auth" {
				if h.transcript != nil {
					t.Fatal("late replacement revived cleared context")
				}
			} else if h.transcript == nil || h.transcript.handle != handle {
				t.Fatal("lost valid prior cache")
			}
		})
	}
}
func TestTranscriptBoundsAndInputValidation(t *testing.T) {
	_, c, call := transcriptHarness(t)
	handle := cacheHandle(t, call("compact", "model.compact", transcriptParams()))
	c.stream = func(context.Context, ModelOptions, func(string)) ([]object, error) {
		t.Fatal("invalid input reached provider")
		return nil, nil
	}
	p := transcriptStream(handle)
	p["history"] = []any{object{"role": "user", "content": strings.Repeat("x", contract.Limits.HistoryBytes-len(syntheticCompact)+1)}}
	assertCode(t, call("limit", "model.stream", p), "invalid_request")
	for _, change := range []object{{"conversationId": ""}, {"contextHandle": 42}, {"compactedContext": syntheticCompact}} {
		p := transcriptStream(handle)
		for k, v := range change {
			p[k] = v
		}
		assertCode(t, call("invalid", "model.stream", p), "invalid_request")
	}
}
func TestActContinuationUsesRetainedCacheAfterHandleExpires(t *testing.T) {
	h, c, call := transcriptHarness(t)
	handle := cacheHandle(t, call("compact", "model.compact", transcriptParams()))
	calls := 0
	c.stream = func(_ context.Context, o ModelOptions, _ func(string)) ([]object, error) {
		calls++
		count := 0
		for _, item := range o.Input {
			if item["type"] == "compaction" {
				count++
			}
		}
		if count != 1 {
			t.Fatal("lost or duplicated initial context", o.Input)
		}
		if calls == 1 {
			return []object{contextCall("one")}, nil
		}
		return nil, nil
	}
	p := contextParams()
	p["conversationId"] = "chat-1"
	p["contextHandle"] = handle
	if call("task", "model.stream", p)["ok"] != true {
		t.Fatal("initial Act failed")
	}
	call("clear", "model.context.clear", object{"conversationId": "chat-1"})
	next := continueParams("one")
	next["conversationId"] = "chat-1"
	if call("task", "model.stream", next)["ok"] != true || h.actTask != nil || calls != 2 {
		t.Fatal("continuation did not use task context")
	}
}

func TestTranscriptEarlyCancellationCannotStartOrReviveCompaction(t *testing.T) {
	for _, method := range []string{"model.cancel", "model.context.clear"} {
		t.Run(method, func(t *testing.T) {
			h, c, _ := transcriptHarness(t)
			c.compact = func(context.Context, ModelOptions) (string, error) {
				t.Fatal("cancelled queued operation reached provider")
				return syntheticCompact, nil
			}
			work := h.modelWork(Request{ID: "pending", Method: "model.compact", Params: transcriptParams()})
			h.Dispatch(context.Background(), Request{ID: "cancel", Method: method, Params: object{"requestId": "pending", "conversationId": "chat-1"}})
			work()
			if h.transcript != nil {
				t.Fatal("queued work revived cache")
			}
		})
	}
}
