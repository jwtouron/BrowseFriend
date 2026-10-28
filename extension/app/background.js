import { MODEL_KEY, normalizeModel } from "../settings/preferences.js";

const STORAGE_KEY = "browsefriend.chat.session";
const MAX_HISTORY_BYTES = 480 * 1024;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_DELTA_SAVE_DELAY_MS = 200;
const CONNECTION_ERROR_CODES = new Set([
  "companion_timeout",
  "companion_unavailable",
  "invalid_api_key",
  "invalid_token",
  "reauth_required",
  "refresh_not_ready",
  "sharing_not_enabled",
  "sign_in_required",
]);

function emptyChat(model = null) {
  return {
    messages: [],
    model,
    historyTruncated: false,
    submission: null,
  };
}

function loadingAuth() {
  return { state: "loading", profile: null, planUsageEnabled: false };
}

function safeError(error, fallback = "BrowseFriend could not complete that operation.") {
  const result = {
    code: typeof error?.code === "string" ? error.code : "app_failed",
    message: typeof error?.message === "string" ? error.message : fallback,
    retryable: error?.retryable === true,
  };
  for (const field of ["status", "requestId", "param", "responseShape"]) {
    if (["string", "number"].includes(typeof error?.[field])) result[field] = error[field];
  }
  return result;
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function historyBefore(messages, endIndex = messages.length) {
  const history = [];
  let bytes = 0;
  for (let index = endIndex - 2; index >= 0; index -= 2) {
    const user = messages[index];
    const assistant = messages[index + 1];
    if (user?.role !== "user" || assistant?.role !== "assistant" ||
        !["complete", "stopped"].includes(assistant.status) || !assistant.text) continue;
    const pair = [
      { role: "user", content: user.text },
      { role: "assistant", content: assistant.text },
    ];
    const size = byteLength(user.text) + byteLength(assistant.text);
    if (bytes + size > MAX_HISTORY_BYTES) break;
    history.unshift(...pair);
    bytes += size;
  }
  return history;
}

function connectionIssue(auth) {
  const planDisabled = auth.state === "plan_disabled";
  return {
    kind: "action",
    action: "sign_in",
    title: planDisabled ? "Enable your ChatGPT plan" : "Sign in to continue",
    message: planDisabled
      ? "BrowseFriend needs permission to use your ChatGPT plan."
      : "Connect a ChatGPT account before sending a message.",
  };
}

function connectionPhase(auth) {
  if (auth.state === "signed_in") return "ready";
  if (auth.state === "plan_disabled") return "plan_required";
  if (auth.state === "signing_in") return "checking";
  return "auth_required";
}

export function installAppController({
  runtime,
  storage,
  settingsStorage,
  companion,
  pageReader,
  randomUUID,
}) {
  let chatPromise;
  let modelCatalogPromise = null;
  let readinessPromise = null;
  let signInPromise = null;
  let connectionEpoch = 0;
  let saveTimer = null;
  let connection = { phase: "checking", auth: loadingAuth(), error: null };
  let issue = null;
  let models = [];
  let modelPreference = "automatic";
  const cancelledSubmissionIds = new Set();

  async function loadChat() {
    if (!chatPromise) {
      chatPromise = storage.get(STORAGE_KEY).then((stored) => {
        const saved = stored?.[STORAGE_KEY];
        if (!saved || !Array.isArray(saved.messages)) return emptyChat();
        const restored = {
          messages: saved.messages,
          model: saved.model || null,
          historyTruncated: saved.historyTruncated === true,
          submission: saved.submission || null,
        };
        if (restored.submission) {
          const assistant = restored.messages.find(
            (message) => message.id === restored.submission.assistantId,
          );
          if (assistant?.status === "streaming") assistant.status = "stopped";
          restored.submission = null;
        } else if (saved.generating) {
          restored.messages = restored.messages.map((message) =>
            message.status === "streaming"
              ? { ...message, status: "stopped", error: null }
              : message);
        }
        return restored;
      });
    }
    return chatPromise;
  }

  function compactChat(chat) {
    const size = () => byteLength(JSON.stringify(chat));
    for (const message of chat.messages) {
      if (size() <= MAX_SESSION_BYTES) return;
      if (message.context?.snapshot) {
        delete message.context.snapshot;
        message.context.discarded = true;
      }
    }
    while (size() > MAX_SESSION_BYTES && chat.messages.length > 2) {
      chat.messages.splice(0, 2);
      chat.historyTruncated = true;
    }
  }

  async function save(chat) {
    compactChat(chat);
    await storage.set({ [STORAGE_KEY]: chat });
  }

  function publicState(chat) {
    return {
      connection,
      issue,
      messages: chat.messages,
      model: chat.model,
      models,
      modelPreference,
      historyTruncated: chat.historyTruncated,
      submission: chat.submission,
    };
  }

  function broadcast(message) {
    runtime.sendMessage({ channel: "app", ...message }).catch(() => undefined);
  }

  async function publish(chat) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await save(chat);
    broadcast({ event: "state", state: publicState(chat) });
  }

  function scheduleSave(chat) {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void save(chat);
    }, MAX_DELTA_SAVE_DELAY_MS);
  }

  async function listModels(refresh = false) {
    if (refresh || !modelCatalogPromise) {
      const request = companion.request("model.list")
        .then((response) => Array.isArray(response.result?.models) ? response.result.models : []);
      modelCatalogPromise = request;
      try {
        return await request;
      } catch (error) {
        if (modelCatalogPromise === request) modelCatalogPromise = null;
        throw error;
      }
    }
    return modelCatalogPromise;
  }

  async function resolveModelPreference(catalog) {
    const stored = await settingsStorage.get(MODEL_KEY);
    const preference = normalizeModel(stored?.[MODEL_KEY]);
    if (preference === "automatic" || catalog.some((model) => model.slug === preference)) {
      return preference;
    }
    await settingsStorage.set({ [MODEL_KEY]: "automatic" });
    return "automatic";
  }

  async function loadModelOptions(refresh = false) {
    const catalog = await listModels(refresh);
    const preference = await resolveModelPreference(catalog);
    models = catalog;
    modelPreference = preference;
    return { models, preference };
  }

  function selectedModel() {
    return modelPreference === "automatic"
      ? models[0]
      : models.find((model) => model.slug === modelPreference);
  }

  async function setAuthOutcome(chat, auth) {
    const phase = connectionPhase(auth);
    if (phase === "ready") {
      connection = { phase: "checking", auth, error: null };
      issue = null;
      await publish(chat);
      return true;
    }
    connection = { phase, auth, error: null };
    models = [];
    issue = connectionIssue(auth);
    await publish(chat);
    return false;
  }

  async function failConnection(chat, error, retry = "connection") {
    const publicError = safeError(error, "BrowseFriend could not finish connecting.");
    connection = { ...connection, phase: "error", error: publicError };
    issue = { kind: "error", scope: "connection", error: publicError, retry };
    await publish(chat);
  }

  function ensureReady({ force = false } = {}) {
    if (readinessPromise) return readinessPromise;

    const request = (async () => {
      const chat = await loadChat();
      if (connection.phase === "ready" && !force) return publicState(chat);
      const epoch = ++connectionEpoch;
      connection = { phase: "checking", auth: connection.auth, error: null };
      if (issue?.scope === "connection") issue = null;
      await publish(chat);
      try {
        const response = await companion.request("auth.status");
        if (epoch !== connectionEpoch) return publicState(chat);
        const auth = response.result || { state: "signed_out", profile: null };
        if (!await setAuthOutcome(chat, auth)) return publicState(chat);
        await loadModelOptions(force);
        if (epoch !== connectionEpoch) return publicState(chat);
        if (!models.length) throw {
          code: "model_unavailable",
          message: "This ChatGPT account did not return an available model.",
          retryable: true,
        };
        connection = { phase: "ready", auth, error: null };
        issue = null;
        await publish(chat);
        void resumeSubmission();
        return publicState(chat);
      } catch (error) {
        if (epoch === connectionEpoch) await failConnection(chat, error);
        return publicState(chat);
      }
    })();
    const tracked = request.finally(() => {
      if (readinessPromise === tracked) readinessPromise = null;
    });
    readinessPromise = tracked;
    return tracked;
  }

  function contextFor(page) {
    if (!page.available) return { available: false, error: page.error };
    return {
      available: true,
      tabId: page.tabId,
      documentId: page.snapshot.documentId,
      revision: page.snapshot.revision,
      title: page.snapshot.title,
      url: page.snapshot.url,
      stale: false,
      snapshot: page.snapshot,
    };
  }

  async function failSubmission(chat, id, error) {
    if (chat.submission?.id !== id) return;
    const submission = chat.submission;
    const publicError = safeError(error, "BrowseFriend could not complete that response.");
    const assistant = chat.messages.find((message) => message.id === submission.assistantId);
    if (assistant) {
      assistant.status = publicError.code === "cancelled" ? "stopped" : "error";
      assistant.error = publicError.code === "cancelled" ? null : publicError;
    }
    chat.submission = null;
    if (publicError.code !== "cancelled") {
      issue = {
        kind: "error",
        scope: "generation",
        error: publicError,
        retry: "generation",
        assistantId: submission.assistantId || null,
        prompt: submission.text,
      };
      if (CONNECTION_ERROR_CODES.has(publicError.code) || [401, 403].includes(publicError.status)) {
        connection = { ...connection, phase: "error", error: publicError };
      }
    }
    await publish(chat);
  }

  async function streamSubmission(chat, submission, history, pageContext) {
    try {
      modelPreference = await resolveModelPreference(models);
      const model = selectedModel();
      if (!model) throw {
        code: "model_unavailable",
        message: "This ChatGPT account did not return an available model.",
        retryable: true,
      };
      chat.model = model;
      await save(chat);
      if (chat.submission?.id !== submission.id) return;
      submission.requestStarted = true;
      await companion.request("model.stream", {
        model: model.slug,
        history,
        prompt: submission.text,
        pageContext,
      }, (event) => {
        if (chat.submission?.id !== submission.id || typeof event.delta !== "string") return;
        const assistant = chat.messages.find((message) => message.id === submission.assistantId);
        if (!assistant) return;
        assistant.text += event.delta;
        scheduleSave(chat);
        broadcast({ event: "delta", messageId: assistant.id, delta: event.delta });
      }, submission.id);

      if (chat.submission?.id !== submission.id) return;
      const assistant = chat.messages.find((message) => message.id === submission.assistantId);
      if (assistant) assistant.status = "complete";
      chat.submission = null;
      issue = null;
      await publish(chat);
    } catch (error) {
      await failSubmission(chat, submission.id, error);
    }
  }

  async function resumeSubmission() {
    const chat = await loadChat();
    const submission = chat.submission;
    if (!submission || submission.phase !== "queued" || connection.phase !== "ready") return;
    submission.phase = "preparing";
    await publish(chat);

    try {
      const page = await pageReader.capture();
      if (chat.submission?.id !== submission.id) return;
      const context = contextFor(page);
      let history;
      let user;
      let assistant;

      if (submission.retryAssistantId) {
        const assistantIndex = chat.messages.findIndex(
          (message) => message.id === submission.retryAssistantId && message.role === "assistant",
        );
        const userIndex = assistantIndex - 1;
        user = chat.messages[userIndex];
        assistant = chat.messages[assistantIndex];
        if (assistantIndex < 1 || user?.role !== "user") throw {
          code: "retry_unavailable",
          message: "That response is no longer available to retry.",
          retryable: false,
        };
        history = historyBefore(chat.messages, userIndex);
        user.context = context;
        assistant.text = "";
        assistant.status = "streaming";
        assistant.error = null;
        assistant.stale = false;
      } else {
        history = historyBefore(chat.messages);
        user = {
          id: randomUUID(),
          role: "user",
          text: submission.text,
          createdAt: Date.now(),
          context,
        };
        assistant = {
          id: randomUUID(),
          role: "assistant",
          text: "",
          status: "streaming",
          stale: false,
          createdAt: Date.now(),
        };
        chat.messages.push(user, assistant);
      }

      submission.userId = user.id;
      submission.assistantId = assistant.id;
      submission.phase = "streaming";
      await publish(chat);
      void streamSubmission(
        chat,
        submission,
        history,
        page.available ? JSON.stringify(page.snapshot) : "",
      );
    } catch (error) {
      await failSubmission(chat, submission.id, error);
    }
  }

  async function submit(id, text) {
    const chat = await loadChat();
    const prompt = String(text || "").trim();
    if (!id || typeof id !== "string" || id.length > 200 || !prompt || prompt.length > 4_000) {
      throw {
        code: "invalid_request",
        message: "Enter a message of 4,000 characters or fewer.",
        retryable: false,
      };
    }
    if (cancelledSubmissionIds.delete(id)) return publicState(chat);
    if (chat.submission) throw {
      code: "model_busy",
      message: "Wait for the current response or stop it first.",
      retryable: true,
    };

    issue = issue?.scope === "generation" ? null : issue;
    chat.submission = { id, text: prompt, phase: "queued" };
    await publish(chat);
    if (connection.phase === "ready") void resumeSubmission();
    else if (connection.phase === "error") void ensureReady({ force: true });
    else if (connection.phase === "checking") void ensureReady();
    return publicState(chat);
  }

  async function stop(id) {
    const chat = await loadChat();
    const submission = chat.submission;
    if (!submission || (id && submission.id !== id)) {
      if (id) {
        cancelledSubmissionIds.add(id);
        if (cancelledSubmissionIds.size > 100) {
          cancelledSubmissionIds.delete(cancelledSubmissionIds.values().next().value);
        }
      }
      return { state: publicState(chat), draft: null };
    }
    const draft = submission.text;
    const assistant = chat.messages.find((message) => message.id === submission.assistantId);
    if (assistant?.status === "streaming") {
      assistant.status = "stopped";
      assistant.error = null;
    }
    chat.submission = null;
    if (issue?.scope === "generation") issue = null;
    await publish(chat);
    if (submission.requestStarted) {
      void companion.request("model.cancel", { requestId: submission.id }).catch(() => undefined);
    }
    return { state: publicState(chat), draft };
  }

  async function retry() {
    const chat = await loadChat();
    const retryIssue = issue;
    if (!retryIssue) return publicState(chat);
    if (retryIssue.retry === "sign_in") return signIn();
    if (retryIssue.retry === "generation") {
      if (chat.submission) throw {
        code: "model_busy",
        message: "Wait for the current response or stop it first.",
        retryable: true,
      };
      issue = null;
      chat.submission = {
        id: randomUUID(),
        text: retryIssue.prompt,
        phase: "queued",
        retryAssistantId: retryIssue.assistantId,
      };
      await publish(chat);
      if (connection.phase === "ready") void resumeSubmission();
      else void ensureReady({ force: true });
      return publicState(chat);
    }
    issue = null;
    await publish(chat);
    void ensureReady({ force: true });
    return publicState(chat);
  }

  function signIn() {
    if (signInPromise) return signInPromise;
    const request = (async () => {
      const chat = await loadChat();
      const epoch = ++connectionEpoch;
      connection = {
        phase: "checking",
        auth: { ...connection.auth, state: "signing_in", error: null },
        error: null,
      };
      issue = {
        kind: "action",
        action: "cancel_sign_in",
        title: "Complete sign-in in your browser",
        message: "BrowseFriend will continue automatically when sign-in finishes.",
      };
      await publish(chat);
      try {
        const response = await companion.request("auth.signIn");
        if (epoch !== connectionEpoch) return publicState(chat);
        const auth = response.result;
        connection = { phase: "checking", auth, error: null };
        issue = null;
        await publish(chat);
        await loadModelOptions(true);
        if (epoch !== connectionEpoch) return publicState(chat);
        if (!models.length) throw {
          code: "model_unavailable",
          message: "This ChatGPT account did not return an available model.",
          retryable: true,
        };
        connection = { phase: "ready", auth, error: null };
        await publish(chat);
        void resumeSubmission();
        return publicState(chat);
      } catch (error) {
        const publicError = safeError(error);
        if (epoch !== connectionEpoch) return publicState(chat);
        if (publicError.code === "cancelled") {
          connection = { phase: "auth_required", auth: { state: "signed_out", profile: null }, error: null };
          issue = connectionIssue(connection.auth);
          await publish(chat);
        } else {
          await failConnection(chat, publicError);
        }
        return publicState(chat);
      }
    })();
    const tracked = request.finally(() => {
      if (signInPromise === tracked) signInPromise = null;
    });
    signInPromise = tracked;
    return tracked;
  }

  async function cancelSignIn() {
    const chat = await loadChat();
    ++connectionEpoch;
    const response = await companion.request("auth.cancel");
    const auth = response.result || { state: "signed_out", profile: null };
    await setAuthOutcome(chat, auth);
    return publicState(chat);
  }

  async function signOut() {
    const chat = await loadChat();
    const activeId = chat.submission?.id;
    if (activeId) await stop(activeId);
    const response = await companion.request("auth.signOut");
    Object.assign(chat, emptyChat());
    models = [];
    modelCatalogPromise = null;
    const auth = response.result || { state: "signed_out", profile: null };
    await setAuthOutcome(chat, auth);
    return { state: publicState(chat), warning: response.warning || null };
  }

  async function clear() {
    const chat = await loadChat();
    const activeId = chat.submission?.id;
    if (activeId) await stop(activeId);
    const cleared = emptyChat(chat.model);
    chatPromise = Promise.resolve(cleared);
    issue = issue?.scope === "generation" ? null : issue;
    await publish(cleared);
    return publicState(cleared);
  }

  pageReader.onDirty((event) => {
    void (async () => {
      const chat = await loadChat();
      let changed = false;
      for (let index = 0; index < chat.messages.length; index += 1) {
        const message = chat.messages[index];
        if (message.role !== "user" || !message.context?.available || message.context.stale ||
            message.context.tabId !== event.tabId ||
            (event.documentId && message.context.documentId !== event.documentId) ||
            (event.documentId && message.context.revision >= event.revision)) continue;
        message.context.stale = true;
        const assistant = chat.messages[index + 1];
        if (assistant?.role === "assistant") assistant.stale = true;
        changed = true;
      }
      if (changed) await publish(chat);
    })();
  });

  companion.subscribe?.((event) => {
    if (event.type === "disconnected") {
      void loadChat().then((chat) => failConnection(chat, event.error));
      return;
    }
    if (event.type !== "auth.changed" || readinessPromise || signInPromise) return;
    const auth = event.state;
    if (auth.state === "signed_in") {
      connection = { phase: "checking", auth, error: null };
      void ensureReady({ force: true });
      return;
    }
    void loadChat().then((chat) => setAuthOutcome(chat, auth));
  });

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== runtime.id || message?.channel !== "app") return false;
    let operation;
    if (message.method === "app.state") operation = loadChat().then(publicState);
    if (message.method === "app.start") {
      operation = loadChat().then((chat) => {
        void ensureReady();
        return publicState(chat);
      });
    }
    if (message.method === "app.submit") operation = submit(message.id, message.text);
    if (message.method === "app.stop") operation = stop(message.id);
    if (message.method === "app.retry") operation = retry();
    if (message.method === "app.clear") operation = clear();
    if (message.method === "app.signIn") operation = signIn();
    if (message.method === "app.cancelSignIn") operation = cancelSignIn();
    if (message.method === "app.signOut") operation = signOut();
    if (message.method === "app.models") {
      operation = loadModelOptions(message.refresh === true).then((result) => ({ ...result }));
    }
    if (!operation) return false;
    operation
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  });

  return {
    clear,
    ensureReady,
    getState: async () => publicState(await loadChat()),
    retry,
    signIn,
    stop,
    submit,
  };
}
