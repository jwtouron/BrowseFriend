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
func TestInstructionOverridesAndAuthDisabled(t *testing.T) {
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
		if _, err := e.SignIn(context.Background(), false); err == nil {
			t.Fatal("sign in enabled")
		}
		if _, err := e.SignOut(context.Background()); err == nil {
			t.Fatal("logout enabled")
		}
		if _, err := e.Compact(context.Background(), companion.ModelOptions{}); err == nil {
			t.Fatal("unexpected compaction")
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
