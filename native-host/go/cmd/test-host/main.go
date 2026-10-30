// Test executable only. Production has no fake-client or test-key switches.
package main

import (
	"browsefriend/nativehost/internal/companion"
	"context"
	"encoding/json"
	"os"
)

type fake struct {
	w    *companion.Writer
	mode string
}

func (f fake) Status(context.Context) (companion.Session, error) {
	if f.mode == "plan-disabled" {
		return companion.Session{State: "plan_disabled"}, nil
	}
	return companion.Session{State: "signed_out"}, nil
}
func (f fake) SignIn(_ context.Context, reconsent bool) (companion.Session, error) {
	f.w.Send(map[string]any{"event": "test.signIn", "reconsent": reconsent})
	return companion.Session{State: "signed_in", PlanUsageEnabled: true}, nil
}
func (f fake) SignOut(context.Context) (companion.Session, error) {
	if f.mode == "revocation-failure" {
		return companion.Session{State: "signed_out"}, &companion.Error{Code: "revocation_failed", Message: "Revocation failed.", Retryable: true}
	}
	return companion.Session{State: "signed_out"}, nil
}
func (f fake) Models(context.Context) ([]map[string]any, error) {
	return []map[string]any{{"slug": "model-1", "displayName": "Model One", "defaultReasoningEffort": "medium", "supportedReasoningEfforts": []string{"low", "medium"}}}, nil
}
func (f fake) Stream(ctx context.Context, o companion.ModelOptions, delta func(string)) ([]map[string]any, error) {
	f.w.Send(map[string]any{"event": "test.options", "options": o})
	if o.Model == "wait" {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if o.Model == "tool" {
		return []map[string]any{{"type": "function_call", "callId": "call-1", "name": "page_click", "arguments": "{\"ref\":\"e1\"}"}}, nil
	}
	if o.Model == "multi" {
		call := map[string]any{"type": "function_call", "callId": "call-1", "name": "page_click", "arguments": "{}"}
		return []map[string]any{call, call}, nil
	}
	if o.Model == "invalid" {
		return []map[string]any{{"type": "function_call", "callId": "call-1", "name": "execute_script", "arguments": "{}"}}, nil
	}
	delta("Hello ")
	delta("world")
	return nil, nil
}
func (f fake) Compact(_ context.Context, o companion.ModelOptions) (string, error) {
	f.w.Send(map[string]any{"event": "test.options", "options": o})
	b, _ := json.Marshal([]map[string]any{{"type": "compaction", "encrypted_content": "opaque"}})
	return string(b), nil
}
func main() {
	w := &companion.Writer{Out: os.Stdout}
	mode := ""
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	h := companion.NewHandler(fake{w, mode}, func(v any) { w.Send(v) })
	companion.Run(context.Background(), os.Stdin, h)
}
