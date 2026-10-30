package companion

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var identifier = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.:\[\]-]{0,159}$`)

func safeID(v any) string {
	s := text(v)
	if identifier.MatchString(s) {
		return s
	}
	return ""
}
func apiError(body any, status int, requestID string) *Error {
	detail, _ := body.(map[string]any)
	for i := 0; i < 4; i++ {
		if v, ok := detail["error"].(map[string]any); ok {
			detail = v
		} else if v, ok := detail["detail"].(map[string]any); ok {
			detail = v
		} else {
			break
		}
	}
	code := safeID(detail["error"])
	if code == "" {
		code = safeID(detail["code"])
	}
	if code == "" {
		code = "api_error"
	}
	message := "ChatGPT could not complete this request."
	retry := false
	switch code {
	case "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused":
		message = "Your ChatGPT connection can no longer be renewed. Sign in again."
	case "access_denied":
		message = "Sign-in was not completed. You can try again when you are ready."
	case "subscription_sharing_usage_limit_exceeded":
		message = "A ChatGPT sharing limit has been reached. Check your usage and app limits in ChatGPT Settings."
	case "subscription_sharing_route_not_supported", "subscription_sharing_unsupported_capability":
		message = "This request uses a capability that ChatGPT plan usage does not support."
	default:
		switch {
		case status == 400 || status == 422:
			message = "ChatGPT rejected this request. Check its input, model, and supported options."
		case status == 401:
			message = "ChatGPT did not accept the selected connection. Check the account and granted permissions."
		case status == 403:
			message = "A ChatGPT policy or permission restriction prevented this request."
		case status == 429:
			message = "Too many requests. Wait a moment before trying again."
			retry = true
		case status >= 500:
			message = "ChatGPT is temporarily unavailable. Try again shortly."
			retry = true
		}
	}
	return &Error{Code: code, Message: message, Retryable: retry, Status: status, RequestID: safeID(requestID), Param: safeID(detail["param"])}
}
func newHTTPClient() *http.Client {
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}
}
func request(ctx context.Context, client *http.Client, method, url, contentType, token string, body io.Reader) (*http.Response, error) {
	r, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	r.Header.Set("Accept", "application/json")
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := client.Do(r)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, failure("network_error", "Could not reach ChatGPT. Check your connection and try again.", true)
	}
	return res, nil
}
func decodeJSON(res *http.Response) (object, error) {
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 4*1024*1024+1))
	if err != nil {
		return nil, err
	}
	var body object
	err = json.Unmarshal(data, &body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, apiError(body, res.StatusCode, res.Header.Get("x-request-id"))
	}
	if err != nil || len(data) > 4*1024*1024 {
		return nil, failure("invalid_response", "ChatGPT returned an unexpected response. Try again.", true)
	}
	return body, nil
}
func apiInput(items []object) []object {
	result := make([]object, 0, len(items))
	for _, item := range items {
		copy := object{}
		for k, v := range item {
			copy[k] = v
		}
		if v, ok := copy["callId"]; ok {
			delete(copy, "callId")
			copy["call_id"] = v
		}
		if copy["type"] == "function_call" && toolAllowed(text(copy["name"])) {
			copy["namespace"] = "browsefriend"
		}
		result = append(result, copy)
	}
	return result
}
func (c *Connection) Models(ctx context.Context) ([]object, error) {
	token, err := c.credentials(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	res, err := request(ctx, c.HTTP, "GET", c.api+"/models", "", token, nil)
	if err != nil {
		return nil, err
	}
	body, err := decodeJSON(res)
	if err != nil {
		return nil, err
	}
	models, ok := body["models"].([]any)
	if !ok {
		return nil, failure("invalid_model_catalog", "ChatGPT returned an unexpected model catalog. Try again.", true)
	}
	result := []object{}
	for _, v := range models {
		m, ok := v.(map[string]any)
		if !ok || m["visibility"] != "list" {
			continue
		}
		slug, name := text(m["slug"]), text(m["display_name"])
		if strings.TrimSpace(slug) == "" || strings.TrimSpace(name) == "" || chars(slug) > 200 || chars(name) > 200 {
			return nil, failure("invalid_model_catalog", "ChatGPT returned an incomplete model listing. Try again.", true)
		}
		entry := object{"slug": slug, "displayName": name}
		if effort := text(m["default_reasoning_level"]); has(contract.Efforts, effort) {
			entry["defaultReasoningEffort"] = effort
		}
		efforts := []string{}
		if levels, ok := m["supported_reasoning_levels"].([]any); ok {
			for _, l := range levels {
				if level, ok := l.(map[string]any); ok {
					e := text(level["effort"])
					if has(contract.Efforts, e) && !has(efforts, e) {
						efforts = append(efforts, e)
					}
				}
			}
		}
		if len(efforts) > 0 {
			entry["supportedReasoningEfforts"] = efforts
		}
		result = append(result, entry)
	}
	return result, nil
}
func (c *Connection) Compact(ctx context.Context, o ModelOptions) (string, error) {
	token, err := c.credentials(ctx)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 180*time.Second)
	defer cancel()
	data, _ := json.Marshal(object{"model": o.Model, "input": apiInput(o.Input)})
	res, err := request(ctx, c.HTTP, "POST", c.api+"/responses/compact", "application/json", token, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	body, err := decodeJSON(res)
	if err != nil {
		return "", err
	}
	out, err := json.Marshal(body["output"])
	if err != nil {
		return "", err
	}
	s := string(out)
	if _, ok := compacted(s); !ok {
		return "", failure("invalid_compaction", "ChatGPT returned invalid compacted context.", false)
	}
	return s, nil
}
func (c *Connection) Stream(ctx context.Context, o ModelOptions, delta func(string)) ([]object, error) {
	token, err := c.credentials(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 180*time.Second)
	defer cancel()
	body := object{"model": o.Model, "input": apiInput(o.Input), "instructions": o.Instructions, "store": false, "stream": true}
	if o.ReasoningEffort != "" {
		body["reasoning"] = object{"effort": o.ReasoningEffort}
	}
	if len(o.Tools) > 0 {
		body["tools"] = []object{{"type": "namespace", "name": "browsefriend", "description": "BrowseFriend page actions", "tools": o.Tools}}
		body["parallel_tool_calls"] = false
	}
	data, _ := json.Marshal(body)
	res, err := request(ctx, c.HTTP, "POST", c.api+"/responses", "application/json", token, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		_, e := decodeJSON(res)
		return nil, e
	}
	defer res.Body.Close()
	ct := strings.TrimSpace(strings.Split(res.Header.Get("Content-Type"), ";")[0])
	if ct != "" && ct != "text/event-stream" {
		return nil, failure("invalid_stream", "ChatGPT did not return the expected response stream.", true)
	}
	return consumeSSE(ctx, res.Body, delta, res.Header.Get("x-request-id"))
}
func consumeSSE(ctx context.Context, in io.Reader, delta func(string), requestID string) ([]object, error) {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	data := []string{}
	eventBytes := 0
	calls := []object{}
	process := func() (bool, error) {
		if len(data) == 0 {
			return false, nil
		}
		joined := strings.Join(data, "\n")
		data = nil
		eventBytes = 0
		if joined == "[DONE]" {
			return false, nil
		}
		var e object
		if json.Unmarshal([]byte(joined), &e) != nil {
			return false, failure("invalid_stream", "The response stream contained an invalid event. Try again.", true)
		}
		switch e["type"] {
		case "response.output_text.delta":
			if s, ok := e["delta"].(string); ok {
				delta(s)
			}
		case "response.output_item.done":
			if item, ok := e["item"].(map[string]any); ok && item["type"] == "function_call" {
				calls = append(calls, object{"type": "function_call", "callId": item["call_id"], "name": item["name"], "arguments": item["arguments"]})
			}
		case "response.completed":
			return true, nil
		case "response.failed":
			return false, apiError(e["response"], 200, requestID)
		case "error":
			return false, apiError(e, 200, requestID)
		case "response.incomplete":
			return false, failure("response_incomplete", "ChatGPT stopped before completing the response. You can keep the partial text or try again.", true)
		}
		return false, nil
	}
	for scanner.Scan() {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		line := scanner.Text()
		if line == "" {
			done, err := process()
			if done || err != nil {
				return calls, err
			}
		} else if strings.HasPrefix(line, "data:") {
			eventBytes += len(line)
			if eventBytes > 1024*1024 {
				return nil, failure("invalid_stream", "The response stream contained an oversized event.", true)
			}
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if scanner.Err() != nil {
		return nil, failure("invalid_stream", "The response stream could not be read. Try again.", true)
	}
	return nil, failure("stream_interrupted", "The response ended before completion. You can keep the partial text or try again.", true)
}
