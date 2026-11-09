package companion

// transcriptContext is a single bounded cache, separate from the active Act buffer.
// The handler mutex protects scope, epochs, and replacement; nothing here is persisted.
type contextScope struct{ conversation, model string }
type transcriptContext struct {
	scope           contextScope
	handle, content string
}

// invalidateContext runs under h.mu and also prevents late compaction from repopulating the cache.
func (h *Handler) invalidateContext() {
	h.contextEpoch++
	h.transcript = nil
	h.contextScope = contextScope{}
}

// AuthChanged handles sanitized connection events, including refresh failures outside auth requests.
func (h *Handler) AuthChanged(s Session) {
	h.clearAuthenticationContext()
	h.Send(object{"event": "auth.changed", "payload": s})
}

func (h *Handler) clearAuthenticationContext() {
	h.mu.Lock()
	h.invalidateContext()
	h.actTask = nil
	if h.modelCancel != nil {
		h.modelCancel()
	}
	h.mu.Unlock()
}

// prepareContext runs after validation, under h.mu. Expired handles fail before a provider request.
func (h *Handler) prepareContext(r Request, o *ModelOptions) (uint64, error) {
	scope := contextScope{text(r.Params["conversationId"]), o.Model}
	// Act continuations already retain their initial context. Never resolve or append it again.
	if r.Method == "model.stream" && text(r.Params["mode"]) == "act" && r.Params["continuation"] != nil {
		return h.contextEpoch, nil
	}
	handle := text(r.Params["contextHandle"])
	if handle != "" && (h.transcript == nil || h.transcript.scope != scope || h.transcript.handle != handle) {
		return h.contextEpoch, failure("model_context_lost", "The conversation context expired. Available transcript history can be used instead.", true)
	}
	if h.contextScope != scope {
		h.invalidateContext()
		h.contextScope = scope
	}
	if handle != "" {
		prior, ok := compacted(h.transcript.content)
		bytes := len(h.transcript.content)
		for _, item := range r.Params["history"].([]any) {
			bytes += len(text(item.(map[string]any)["content"]))
		}
		if !ok || bytes > contract.Limits.HistoryBytes {
			return h.contextEpoch, failure("invalid_request", "Conversation history exceeds its limit.", false)
		}
		o.Input = append(prior, o.Input...)
	}
	return h.contextEpoch, nil
}
