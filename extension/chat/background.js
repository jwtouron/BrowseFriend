const STORAGE_KEY = "browsefriend.chat.session";
const MAX_HISTORY_BYTES = 480 * 1024;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const SAVE_DELAY_MS = 200;

function emptyState(model = null) {
  return {
    messages: [],
    model,
    generating: false,
    requestId: null,
    error: null,
    historyTruncated: false,
  };
}

function safeError(error, fallback = "BrowseFriend could not complete that response.") {
  return {
    code: typeof error?.code === "string" ? error.code : "chat_failed",
    message: typeof error?.message === "string" ? error.message : fallback,
    retryable: error?.retryable === true,
  };
}

function historyFor(messages) {
  const history = [];
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(["user", "assistant"].includes(message.role)) || !message.text ||
        message.status === "error" || message.status === "streaming") continue;
    const size = new TextEncoder().encode(message.text).byteLength;
    if (bytes + size > MAX_HISTORY_BYTES) break;
    history.unshift({ role: message.role, content: message.text });
    bytes += size;
  }
  return history;
}

export function installChatController({ runtime, storage, companion, pageReader, randomUUID }) {
  let statePromise;
  let saveTimer = null;

  async function loadState() {
    if (!statePromise) {
      statePromise = storage.get(STORAGE_KEY).then((stored) => {
        const saved = stored?.[STORAGE_KEY];
        if (!saved || !Array.isArray(saved.messages)) return emptyState();
        const restored = { ...emptyState(saved.model || null), ...saved };
        if (restored.generating) {
          restored.generating = false;
          restored.requestId = null;
          restored.messages = restored.messages.map((message) =>
            message.status === "streaming"
              ? { ...message, status: "stopped", error: null }
              : message);
        }
        return restored;
      });
    }
    return statePromise;
  }

  function compactState(state) {
    const size = () => new TextEncoder().encode(JSON.stringify(state)).byteLength;
    for (const message of state.messages) {
      if (size() <= MAX_SESSION_BYTES) return;
      if (message.context?.snapshot) {
        delete message.context.snapshot;
        message.context.discarded = true;
      }
    }
    while (size() > MAX_SESSION_BYTES && state.messages.length > 2) {
      state.messages.splice(0, 2);
      state.historyTruncated = true;
    }
  }

  async function save(state) {
    compactState(state);
    await storage.set({ [STORAGE_KEY]: state });
  }

  function scheduleSave(state) {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void save(state);
    }, SAVE_DELAY_MS);
  }

  function broadcast(message) {
    runtime.sendMessage({ channel: "chat", ...message }).catch(() => undefined);
  }

  async function publishState(state) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await save(state);
    broadcast({ event: "state", state });
  }

  async function ensureModel(state) {
    if (state.model?.slug) return state.model;
    const response = await companion.request("model.list");
    const model = response.result?.models?.[0];
    if (!model) throw {
      code: "model_unavailable",
      message: "This ChatGPT account did not return an available model.",
      retryable: true,
    };
    state.model = model;
    return model;
  }

  async function runGeneration(state, generationId, assistantId, prompt, history, pageContext) {
    try {
      const model = await ensureModel(state);
      if (state.requestId !== generationId) return;
      await save(state);
      await companion.request("model.stream", {
        model: model.slug,
        history,
        prompt,
        pageContext,
      }, (event) => {
        if (state.requestId !== generationId || typeof event.delta !== "string") return;
        const assistant = state.messages.find((message) => message.id === assistantId);
        if (!assistant) return;
        assistant.text += event.delta;
        scheduleSave(state);
        broadcast({ event: "delta", messageId: assistantId, delta: event.delta });
      }, generationId);

      if (state.requestId !== generationId) return;
      const assistant = state.messages.find((message) => message.id === assistantId);
      if (assistant) assistant.status = "complete";
      state.generating = false;
      state.requestId = null;
      state.error = null;
      await publishState(state);
    } catch (error) {
      if (state.requestId !== generationId) return;
      const publicError = safeError(error);
      const assistant = state.messages.find((message) => message.id === assistantId);
      if (assistant) {
        assistant.status = publicError.code === "cancelled" ? "stopped" : "error";
        assistant.error = publicError.code === "cancelled" ? null : publicError;
      }
      state.generating = false;
      state.requestId = null;
      state.error = publicError.code === "cancelled" ? null : publicError;
      await publishState(state);
    }
  }

  async function sendMessage(text) {
    const state = await loadState();
    const prompt = String(text || "").trim();
    if (!prompt || prompt.length > 4_000) throw {
      code: "invalid_request",
      message: "Enter a message of 4,000 characters or fewer.",
      retryable: false,
    };
    if (state.generating) throw {
      code: "model_busy",
      message: "Wait for the current response or stop it first.",
      retryable: true,
    };

    const history = historyFor(state.messages);
    const page = await pageReader.capture();
    const userId = randomUUID();
    const assistantId = randomUUID();
    const generationId = randomUUID();
    const context = page.available
      ? {
          available: true,
          tabId: page.tabId,
          documentId: page.snapshot.documentId,
          revision: page.snapshot.revision,
          title: page.snapshot.title,
          url: page.snapshot.url,
          stale: false,
          snapshot: page.snapshot,
        }
      : { available: false, error: page.error };

    state.messages.push(
      { id: userId, role: "user", text: prompt, createdAt: Date.now(), context },
      {
        id: assistantId,
        role: "assistant",
        text: "",
        status: "streaming",
        stale: false,
        createdAt: Date.now(),
      },
    );
    state.generating = true;
    state.requestId = generationId;
    state.error = null;
    await publishState(state);
    void runGeneration(
      state,
      generationId,
      assistantId,
      prompt,
      history,
      page.available ? JSON.stringify(page.snapshot) : "",
    );
    return state;
  }

  async function cancel() {
    const state = await loadState();
    if (!state.generating || !state.requestId) return state;
    await companion.request("model.cancel", { requestId: state.requestId });
    return state;
  }

  async function clear() {
    const state = await loadState();
    const activeRequestId = state.generating ? state.requestId : null;
    if (activeRequestId) {
      state.generating = false;
      state.requestId = null;
      await companion.request("model.cancel", { requestId: activeRequestId }).catch(() => undefined);
    }
    const cleared = emptyState(state.model);
    statePromise = Promise.resolve(cleared);
    await publishState(cleared);
    return cleared;
  }

  pageReader.onDirty((event) => {
    void (async () => {
      const state = await loadState();
      let changed = false;
      for (let index = 0; index < state.messages.length; index += 1) {
        const message = state.messages[index];
        if (message.role !== "user" || !message.context?.available || message.context.stale ||
            message.context.tabId !== event.tabId ||
            (event.documentId && message.context.documentId !== event.documentId) ||
            (event.documentId && message.context.revision >= event.revision)) continue;
        message.context.stale = true;
        const assistant = state.messages[index + 1];
        if (assistant?.role === "assistant") assistant.stale = true;
        changed = true;
      }
      if (changed) await publishState(state);
    })();
  });

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== runtime.id || message?.channel !== "chat") return false;
    let operation;
    if (message.method === "chat.state") operation = loadState();
    if (message.method === "chat.send") operation = sendMessage(message.text);
    if (message.method === "chat.cancel") operation = cancel();
    if (message.method === "chat.clear") operation = clear();
    if (!operation) return false;
    operation
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  });

  return { clear, getState: loadState };
}
