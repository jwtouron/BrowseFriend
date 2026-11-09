package companion

import (
	"context"
	"errors"

	hostcontract "browsefriend/shared"
)

type object = map[string]any

var contract = hostcontract.Contract

type Error struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
	Status    int    `json:"status,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	Param     string `json:"param,omitempty"`
}

func (e *Error) Error() string { return e.Code }
func failure(code, message string, retryable bool) *Error {
	return &Error{Code: code, Message: message, Retryable: retryable}
}
func publicError(err error) *Error {
	var safe *Error
	if errors.As(err, &safe) {
		return safe
	}
	if errors.Is(err, context.Canceled) {
		return failure("cancelled", "The request was cancelled.", false)
	}
	return failure("native_host_error", "The BrowseFriend companion failed.", true)
}

type Session struct {
	State            string `json:"state"`
	Profile          object `json:"profile"`
	PlanUsageEnabled bool   `json:"planUsageEnabled"`
	Error            *Error `json:"error,omitempty"`
}
type Request struct {
	authEpoch uint64
	ID        any    `json:"id"`
	Method    string `json:"method"`
	Params    object `json:"params"`
}
type ModelOptions struct {
	Model           string   `json:"model"`
	Input           []object `json:"input"`
	Instructions    string   `json:"instructions,omitempty"`
	ReasoningEffort string   `json:"reasoningEffort,omitempty"`
	Tools           []object `json:"tools,omitempty"`
}
type Client interface {
	Status(context.Context) (Session, error)
	SignIn(context.Context, bool) (Session, error)
	SignOut(context.Context) (Session, error)
	ResetLogin(context.Context) (Session, error)
	Models(context.Context) ([]object, error)
	// Stream returns canonical output items in their original order.
	Stream(context.Context, ModelOptions, func(string)) ([]object, error)
	Compact(context.Context, ModelOptions) (string, error)
}

func text(v any) string { s, _ := v.(string); return s }
func has(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func toolAllowed(name string) bool {
	for _, t := range contract.Tools {
		if t["name"] == name {
			return true
		}
	}
	return false
}
