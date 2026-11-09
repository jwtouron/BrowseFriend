package main

import (
	"browsefriend/native-host/internal/companion"
	contract "browsefriend/shared"
	"context"
	"testing"
)

type recorder struct {
	companion.Client
	options companion.ModelOptions
}

func (r *recorder) Stream(_ context.Context, o companion.ModelOptions, delta func(string)) ([]map[string]any, error) {
	r.options = o
	delta("synthetic")
	return nil, nil
}
func TestInstructionOverrides(t *testing.T) {
	for _, judge := range []bool{false, true} {
		r := &recorder{}
		e := evaluator{Client: r, instructions: "baseline", judge: judge}
		_, err := e.Stream(context.Background(), companion.ModelOptions{Instructions: "ask", Tools: contract.Contract.Tools}, func(string) {})
		if err != nil {
			t.Fatal(err)
		}
		if judge {
			if r.options.Instructions != rubric || len(r.options.Tools) != 0 {
				t.Fatal("grader gained tools")
			}
		} else if r.options.Instructions != contract.Contract.BaseInstructions+"\n\nbaseline" {
			t.Fatal("baseline changed base policy")
		}
	}
}
func TestActorAskInstructionsRemainUnchanged(t *testing.T) {
	r := &recorder{}
	e := evaluator{Client: r, instructions: "baseline"}
	_, err := e.Stream(context.Background(), companion.ModelOptions{Instructions: "ask"}, func(string) {})
	if err != nil || r.options.Instructions != "ask" {
		t.Fatal("ask policy changed", err)
	}
}

func (r *recorder) SignIn(context.Context, bool) (companion.Session, error) {
	return companion.Session{State: "signed_in"}, nil
}
func (r *recorder) Compact(context.Context, companion.ModelOptions) (string, error) {
	return "synthetic-compact", nil
}
func TestEvaluationAuthAndCompactionUseTheSameClient(t *testing.T) {
	e := &evaluator{Client: &recorder{}}
	if s, err := e.SignIn(context.Background(), false); err != nil || s.State != "signed_in" {
		t.Fatal(s, err)
	}
	if s, err := e.Compact(context.Background(), companion.ModelOptions{}); err != nil || s != "synthetic-compact" {
		t.Fatal(s, err)
	}
	if _, err := e.ResetLogin(context.Background()); err == nil {
		t.Fatal("evaluation unexpectedly reset saved login")
	}
	if _, err := e.SignOut(context.Background()); err == nil {
		t.Fatal("evaluation unexpectedly logged out")
	}
}
func TestEvaluationConfigurationRejectsBusyAndUnknownModes(t *testing.T) {
	replies := make(chan map[string]any, 4)
	e := &evaluator{Client: &recorder{}, baseline: "baseline"}
	h := &evaluationHandler{evaluator: e, pending: map[string]bool{"active": true}}
	h.Handler = companion.NewHandler(e, func(v any) { replies <- v.(map[string]any) })
	defer h.Close()
	configure := func(variant string) map[string]any {
		h.Dispatch(context.Background(), companion.Request{ID: "configure", Method: "eval.configure", Params: map[string]any{"variant": variant}})
		return <-replies
	}
	if configure("judge")["ok"] != false {
		t.Fatal("changed active evaluation mode")
	}
	delete(h.pending, "active")
	if configure("unknown")["ok"] != false {
		t.Fatal("unknown mode accepted")
	}
	if configure("judge")["ok"] != true || !e.judge {
		t.Fatal("judge not selected")
	}
	if configure("baseline")["ok"] != true || e.judge || e.instructions != "baseline" {
		t.Fatal("baseline not selected")
	}
	if configure("candidate")["ok"] != true || e.instructions != contract.Contract.ActInstructions {
		t.Fatal("candidate not selected")
	}
}
