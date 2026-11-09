import { canResetSavedLogin, requiresReauthentication } from "../auth/errors.js";
import {
  MODEL_KEY,
  REASONING_KEY,
  normalizeModel,
} from "../settings/preferences.js";
import { parsePageToolCall } from "../../shared/page-tools.js";
import {
  normalizeReasoningPreference,
  selectReasoningEffort,
  supportedReasoningEfforts,
} from "../../shared/reasoning.js";
import { selectModel } from "../../shared/model-selection.js";
import {
  actionHistoryContext,
  actionLabel,
} from "../../shared/action-history.js";

const STORAGE_KEY = "browsefriend.chat.session";
const MAX_HISTORY_BYTES = 480 * 1024;
const MAX_HISTORY_MESSAGES = 200;
const MAX_COMPACTION_BYTES = 320 * 1024;
const COMPACTION_TRIGGER_BYTES = 256 * 1024;
const RECENT_EXCHANGE_LIMIT = 8;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_DELTA_SAVE_DELAY_MS = 200;
const MAX_ACTION_CALLS = 32;
const CONNECTION_ERROR_CODES = new Set([
  "credentials_invalid", "credentials_version_unsupported", "credentials_too_large",
  "storage_unavailable", "storage_unsafe", "storage_busy", "registration_invalid",
  "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
  "refresh_token_invalidated", "refresh_token_reused", "invalid_id_token", "invalid_token_response", "account_mismatch",
  "companion_timeout",
  "companion_unavailable",
  "invalid_api_key",
  "invalid_token",
  "reauth_required",
  "refresh_not_ready",
  "sharing_not_enabled",
  "sign_in_required",
]);

function emptyChat(model, conversationId) {
  return {
    messages: [],
    conversationId,
    model,
    compaction: null,
    historyTruncated: false,
    submission: null,
    mode: "ask",
    authorization: null,
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

function exchangesBefore(messages, endIndex = messages.length) {
  const exchanges = [];
  for (let index = 0; index + 1 < endIndex; index += 2) {
    const user = messages[index];
    const assistant = messages[index + 1];
    const hasActions = Array.isArray(assistant?.actions) && assistant.actions.length > 0;
    if (user?.role !== "user" || assistant?.role !== "assistant" ||
        !["complete", "stopped"].includes(assistant.status) || (!assistant.text && !hasActions)) continue;
    exchanges.push({ user, assistant });
  }
  return exchanges;
}

function exchangeMessages(exchange, includeActions = false) {
  const actions = includeActions ? actionHistoryContext(exchange.assistant.actions) : "";
  const assistantContent = [exchange.assistant.text, actions].filter(Boolean).join("\n\n");
  if (!assistantContent) return [];
  return [
    { role: "user", content: exchange.user.text },
    { role: "assistant", content: assistantContent },
  ];
}

function boundedHistory(exchanges, contextBytes = 0) {
  const history = [];
  let bytes = contextBytes;
  const recentStart = Math.max(0, exchanges.length - RECENT_EXCHANGE_LIMIT);
  for (let index = exchanges.length - 1; index >= 0; index -= 1) {
    const pair = exchangeMessages(exchanges[index], index >= recentStart);
    const size = pair.reduce((total, message) => total + byteLength(message.content), 0);
    if (!pair.length) continue;
    if (bytes + size > MAX_HISTORY_BYTES || history.length + pair.length > MAX_HISTORY_MESSAGES) break;
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
  pageActor,
  randomUUID,
}) {
  let chatPromise;
  let modelCatalogPromise = null;
  let readinessPromise = null;
  let signInPromise = null;
  let accountMutationPromise = null;
  let connectionEpoch = 0;
  let saveTimer = null;
  let connection = { phase: "checking", auth: loadingAuth(), error: null };
  let issue = null;
  let models = [];
  let modelPreference = "automatic";
  let reasoningPreference = "model_default";
  const compactionUnavailableModels = new Set();
  const cancelledSubmissionIds = new Set();

  async function loadChat() {
    if (!chatPromise) {
      chatPromise = storage.get(STORAGE_KEY).then((stored) => {
        const saved = stored?.[STORAGE_KEY];
        if (!saved || !Array.isArray(saved.messages)) return emptyChat(null, randomUUID());
        const restored = {
          messages: saved.messages,
          conversationId: typeof saved.conversationId === "string" && saved.conversationId ? saved.conversationId : randomUUID(),
          model: saved.model || null,
          compaction: saved.compaction || null,
          historyTruncated: saved.historyTruncated === true,
          submission: saved.submission || null,
          mode: saved.mode === "act" && saved.authorization ? "act" : "ask",
          authorization: saved.mode === "act" && saved.authorization ? saved.authorization : null,
        };
        if (restored.submission) {
          const assistant = restored.messages.find(
            (message) => message.id === restored.submission.assistantId,
          );
          if (assistant?.status === "streaming") assistant.status = "stopped";
          restored.submission = null;
          restored.mode = "ask";
          restored.authorization = null;
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
      reasoningPreference,
      historyTruncated: chat.historyTruncated,
      submission: chat.submission,
      mode: chat.mode,
      authorization: chat.authorization,
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

  async function resolveReasoningPreference(model) {
    const stored = await settingsStorage.get(REASONING_KEY);
    const preference = normalizeReasoningPreference(stored?.[REASONING_KEY]);
    const supported = supportedReasoningEfforts(model);
    if (preference === "model_default" || supported.includes(preference)) {
      if (stored?.[REASONING_KEY] !== preference) {
        await settingsStorage.set({ [REASONING_KEY]: preference });
      }
      return preference;
    }
    await settingsStorage.set({ [REASONING_KEY]: "model_default" });
    return "model_default";
  }

  async function loadModelOptions(refresh = false) {
    const catalog = await listModels(refresh);
    const preference = await resolveModelPreference(catalog);
    models = catalog;
    modelPreference = preference;
    const chat = await loadChat();
    if (chat.compaction && chat.compaction.model !== selectedModel()?.slug) await clearModelContext(chat);
    return { models, preference };
  }

  function selectedModel() {
    return selectModel(models, modelPreference);
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
    chat.compaction = null;
    chat.mode = "ask";
    chat.authorization = null;
    issue = connectionIssue(auth);
    await publish(chat);
    return false;
  }

  async function failConnection(chat, error, retry = "connection") {
    const publicError = safeError(error, "BrowseFriend could not finish connecting.");
    connection = { ...connection, phase: "error", error: publicError };
    issue = { kind: "error", scope: "connection", error: publicError, retry: canResetSavedLogin(publicError) ? null : retry };
    await publish(chat);
  }

  function ensureReady({ force = false } = {}) {
    if (accountMutationPromise) return accountMutationPromise.then((result) => result.state);
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
        void resumeRetry();
        return publicState(chat);
      } catch (error) {
        if (epoch === connectionEpoch) {
          if (requiresReauthentication(error)) {
            await setAuthOutcome(chat, { state: "signed_out", profile: null, planUsageEnabled: false });
          } else await failConnection(chat, error);
        }
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

  function pageOrigin(url) {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  function authorizedFor(chat, context) {
    return chat.mode === "act" && context.available &&
      chat.authorization?.tabId === context.tabId &&
      chat.authorization?.origin === pageOrigin(context.url);
  }

  function authorizedForSubmission(chat, submission, context) {
    return chat.mode === "act" && submission.mode === "act" && context?.available &&
      submission.tabId === context.tabId;
  }

  function finishTaskMode(chat, submission) {
    if (submission?.mode !== "act" || !submission.startOrigin || !submission.currentOrigin ||
        submission.startOrigin === submission.currentOrigin) return;
    chat.mode = "ask";
    chat.authorization = null;
  }

  function finishSubmission(chat, submission) {
    finishTaskMode(chat, submission);
    chat.submission = null;
    if (submission.requestStarted) {
      void companion.request("model.cancel", { requestId: submission.id }).catch(() => undefined);
    }
  }

  function assistantFor(chat, submission) {
    return chat.messages.find((message) => message.id === submission.assistantId);
  }

  function publicAction(prepared, id, status = "running") {
    return {
      id,
      status,
      kind: prepared.kind,
      target: prepared.target || "Page",
      ...(prepared.value !== undefined ? { value: prepared.value } : {}),
      ...(prepared.destination ? { destination: prepared.destination } : {}),
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
    finishSubmission(chat, submission);
    if (publicError.code !== "cancelled") {
      const canRetry = !submission.actionExecuted &&
        !["action_limit_reached", "action_loop_detected", "act_authorization_changed",
          "user_navigated", "act_context_lost", "act_context_limit"].includes(publicError.code);
      issue = {
        kind: "error",
        scope: "generation",
        error: publicError,
        retry: canRetry ? "generation" : null,
        assistantId: submission.assistantId || null,
        prompt: submission.text,
      };
      if (CONNECTION_ERROR_CODES.has(publicError.code) || [401, 403].includes(publicError.status)) {
        connection = { ...connection, phase: "error", error: publicError };
      }
    }
    if (requiresReauthentication(publicError)) {
      await setAuthOutcome(chat, { state: "signed_out", profile: null, planUsageEnabled: false });
      return;
    }
    await publish(chat);
  }

  async function captureForSubmission(chat, submission, { afterNavigation = false } = {}) {
    const previousContext = submission.context;
    const page = afterNavigation && previousContext && pageReader.captureAfterNavigation
      ? await pageReader.captureAfterNavigation(previousContext)
      : await pageReader.capture();
    if (chat.submission?.id !== submission.id) return null;
    const context = contextFor(page);
    if (submission.mode === "act") {
      if (!context.available) throw {
        code: context.error?.code || "page_unavailable",
        message: context.error?.message || "BrowseFriend could not read the active page.",
        retryable: false,
      };
      if (!submission.tabId) {
        if (!authorizedFor(chat, context)) throw {
          code: "act_authorization_changed",
          message: "Act mode stopped because the active tab or site changed before the task began.",
          retryable: false,
        };
        submission.tabId = context.tabId;
        submission.startOrigin = chat.authorization.origin;
      } else if (submission.tabId !== context.tabId) {
        chat.mode = "ask";
        chat.authorization = null;
        throw {
          code: "user_navigated",
          message: "Stopped because you navigated away.",
          retryable: false,
        };
      }
      submission.currentOrigin = pageOrigin(context.url);
      submission.currentUrl = context.url;
      chat.authorization = { tabId: submission.tabId, origin: submission.currentOrigin };
    } else if (context.available) {
      submission.tabId = context.tabId;
      submission.currentOrigin = pageOrigin(context.url);
      submission.currentUrl = context.url;
    }
    submission.context = context;
    return context;
  }

  function submissionExchanges(chat, submission) {
    const userIndex = chat.messages.findIndex((message) => message.id === submission.userId);
    return exchangesBefore(chat.messages, userIndex < 0 ? chat.messages.length : userIndex);
  }

  async function clearModelContext(chat) {
    chat.compaction = null;
    await companion.request("model.context.clear", { conversationId: chat.conversationId }).catch(() => undefined);
  }

  function compactionFor(chat, modelSlug) {
    const value = chat.compaction;
    if (!value || value.model !== modelSlug || typeof value.handle !== "string" || !value.handle || value.handle.length > 200 ||
        !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_COMPACTION_BYTES ||
        typeof value.throughAssistantId !== "string" || !Number.isFinite(value.throughCreatedAt)) {
      chat.compaction = null;
      return null;
    }
    return value;
  }

  function exchangesAfterCompaction(exchanges, compaction) {
    if (!compaction) return exchanges;
    const checkpoint = exchanges.findIndex(
      (exchange) => exchange.assistant.id === compaction.throughAssistantId,
    );
    if (checkpoint >= 0) return exchanges.slice(checkpoint + 1);
    if (Number.isFinite(compaction.throughCreatedAt)) {
      return exchanges.filter(
        (exchange) => !Number.isFinite(exchange.assistant.createdAt) ||
          exchange.assistant.createdAt > compaction.throughCreatedAt,
      );
    }
    return exchanges;
  }

  function reusableContextBytes(exchanges, contextBytes = 0) {
    const recentStart = Math.max(0, exchanges.length - RECENT_EXCHANGE_LIMIT);
    let total = contextBytes;
    for (const [index, exchange] of exchanges.entries()) {
      for (const message of exchangeMessages(exchange, index >= recentStart)) {
        total += byteLength(message.content);
      }
    }
    return total;
  }

  function compactionUnsupported(error) {
    return [400, 403, 404, 405].includes(error?.status) ||
      ["invalid_request", "method_not_found", "unsupported_method"].includes(error?.code);
  }

  async function prepareModelHistory(chat, submission, model) {
    const exchanges = submissionExchanges(chat, submission);
    let compaction = compactionFor(chat, model.slug);
    let remaining = exchangesAfterCompaction(exchanges, compaction);

    if (!submission.compactionChecked && !compactionUnavailableModels.has(model.slug) &&
        remaining.length > RECENT_EXCHANGE_LIMIT &&
        reusableContextBytes(remaining, compaction?.bytes || 0) > COMPACTION_TRIGGER_BYTES) {
      const compactable = remaining.slice(0, -RECENT_EXCHANGE_LIMIT);
      const history = compactable.flatMap((exchange) => exchangeMessages(exchange, false));
      if (history.length || compaction?.handle) {
        submission.requestStarted = true;
        try {
          const response = await companion.request("model.compact", {
            model: model.slug,
            conversationId: chat.conversationId,
            ...(compaction?.handle ? { contextHandle: compaction.handle } : {}),
            history,
          }, undefined, submission.id);
          if (chat.submission?.id !== submission.id) return null;
          const { contextHandle: handle, contextBytes: bytes } = response.result || {};
          if (typeof handle !== "string" || !handle || handle.length > 200 ||
              !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_COMPACTION_BYTES) {
            throw { code: "invalid_compaction", message: "ChatGPT returned invalid compacted context." };
          }
          const checkpoint = compactable.at(-1).assistant;
          chat.compaction = {
            model: model.slug,
            handle,
            bytes,
            throughAssistantId: checkpoint.id,
            throughCreatedAt: checkpoint.createdAt,
          };
          compaction = chat.compaction;
          remaining = remaining.slice(-RECENT_EXCHANGE_LIMIT);
          await save(chat);
        } catch (error) {
          if (chat.submission?.id !== submission.id) return null;
          if (error?.code === "cancelled") throw error;
          if (error?.code === "model_context_lost") {
            chat.compaction = null;
            compaction = null;
            remaining = exchanges;
            submission.contextFallbackUsed = true;
            await save(chat);
          }
          if (compactionUnsupported(error) || error?.code === "invalid_compaction") {
            compactionUnavailableModels.add(model.slug);
          }
        }
      }
    }

    submission.compactionChecked = true;
    return {
      contextHandle: compaction?.handle || "",
      history: boundedHistory(remaining, compaction?.bytes || 0),
    };
  }

  async function continueAfterAction(chat, submission, call, result, action) {
    if (chat.submission?.id !== submission.id) return;
    if (action) action.status = result.cancelled ? "cancelled" : "complete";
    submission.actionExecuted = submission.actionExecuted || result.executed === true || result.waitingForUser === true;
    submission.actionHistory.push(actionLabel(result));
    submission.continuation = {
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      output: JSON.stringify({
        ok: true,
        kind: result.kind,
        target: result.target,
        ...(result.value !== undefined ? { value: result.value } : {}),
        ...(result.changed !== undefined ? { changed: result.changed } : {}),
      }),
    };
    const context = await captureForSubmission(chat, submission, {
      afterNavigation: result.kind === "navigation" ||
        (submission.currentUrl && submission.currentUrl !== submission.context?.url),
    });
    if (!context || chat.submission?.id !== submission.id) return;
    submission.phase = "streaming";
    submission.pendingAction = null;
    await publish(chat);
    void streamSubmission(chat, submission);
  }

  async function executePageAction(chat, submission, call, prepared, action) {
    try {
      if (submission.phase !== "executing") {
        submission.phase = "executing";
        submission.pendingAction = null;
        await publish(chat);
      }
      const result = await pageActor.execute(call, submission.context);
      if (chat.submission?.id !== submission.id) return;
      if (result.waitingForUser) {
        action.status = "waiting";
        submission.phase = "waiting_file";
        submission.pendingAction = { id: action.id, call, prepared, context: submission.context };
        await publish(chat);
        return;
      }
      await continueAfterAction(chat, submission, call, result, action);
    } catch (error) {
      if (["stale_page", "stale_target"].includes(error?.code)) {
        action.status = "stale";
        submission.actionHistory.push(`Skipped stale ${prepared.target || "page control"}`);
        submission.continuation = {
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
          output: JSON.stringify({ ok: false, code: error.code, message: error.message }),
        };
        const context = await captureForSubmission(chat, submission);
        if (!context || chat.submission?.id !== submission.id) return;
        submission.phase = "streaming";
        submission.pendingAction = null;
        await publish(chat);
        void streamSubmission(chat, submission);
        return;
      }
      throw error;
    }
  }

  async function handleToolCall(chat, submission, rawCall) {
    let call;
    try {
      call = parsePageToolCall(rawCall);
    } catch (error) {
      throw { code: "invalid_tool_call", message: error.message, retryable: true };
    }
    if (!authorizedForSubmission(chat, submission, submission.context)) {
      throw {
        code: "act_authorization_changed",
        message: "BrowseFriend no longer has permission to act on this page.",
        retryable: false,
      };
    }
    submission.actionCount += 1;
    if (submission.actionCount > MAX_ACTION_CALLS) throw {
      code: "action_limit_reached",
      message: `BrowseFriend paused after ${MAX_ACTION_CALLS} page actions. Review the page and ask it to continue.`,
      retryable: false,
    };
    const fingerprint = `${call.name}:${call.arguments}:${submission.context.documentId}:${submission.context.revision}`;
    if (fingerprint === submission.lastActionFingerprint) throw {
      code: "action_loop_detected",
      message: "BrowseFriend stopped after the model repeated the same page action.",
      retryable: false,
    };
    submission.lastActionFingerprint = fingerprint;

    let prepared;
    try {
      prepared = await pageActor.prepare(call, submission.context);
    } catch (error) {
      if (!["stale_page", "stale_target"].includes(error?.code)) throw error;
      submission.actionHistory.push("Skipped a stale page control");
      submission.continuation = {
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
        output: JSON.stringify({ ok: false, code: error.code, message: error.message }),
      };
      const context = await captureForSubmission(chat, submission);
      if (!context || chat.submission?.id !== submission.id) return;
      await publish(chat);
      void streamSubmission(chat, submission);
      return;
    }
    if (chat.submission?.id !== submission.id) return;
    const assistant = assistantFor(chat, submission);
    const actionId = randomUUID();
    const action = publicAction(prepared, actionId);
    assistant.actions ||= [];
    assistant.actions.push(action);

    if (prepared.requiresConfirmation) {
      action.status = "pending";
      submission.phase = "waiting_confirmation";
      submission.pendingAction = { id: actionId, call, prepared, context: submission.context };
      await publish(chat);
      return;
    }
    await executePageAction(chat, submission, call, prepared, action);
  }

  async function streamSubmission(chat, submission) {
    try {
      let model;
      if (submission.modelSlug) {
        model = models.find((item) => item.slug === submission.modelSlug) ||
          (chat.model?.slug === submission.modelSlug ? chat.model : null);
      } else {
        modelPreference = await resolveModelPreference(models);
        model = selectedModel();
      }
      if (!model) throw {
        code: "model_unavailable",
        message: "This ChatGPT account did not return an available model.",
        retryable: true,
      };
      if (!submission.modelSlug) {
        reasoningPreference = await resolveReasoningPreference(model);
        submission.modelSlug = model.slug;
        submission.reasoningEffort = selectReasoningEffort(model, reasoningPreference) || null;
      }
      if (chat.compaction && chat.compaction.model !== model.slug) await clearModelContext(chat);
      if (chat.submission?.id !== submission.id) return;
      const preparedHistory = submission.continuation
        ? { history: [], contextHandle: "" }
        : await prepareModelHistory(chat, submission, model);
      if (!preparedHistory || chat.submission?.id !== submission.id) return;
      chat.model = model;
      await save(chat);
      if (chat.submission?.id !== submission.id) return;
      submission.requestStarted = true;
      const response = await companion.request("model.stream", {
        model: model.slug,
        conversationId: chat.conversationId,
        ...(submission.reasoningEffort ? { reasoningEffort: submission.reasoningEffort } : {}),
        ...(preparedHistory.contextHandle
          ? { contextHandle: preparedHistory.contextHandle }
          : {}),
        history: preparedHistory.history,
        prompt: submission.text,
        pageContext: submission.context?.available ? JSON.stringify(submission.context.snapshot) : "",
        mode: submission.mode,
        actionHistory: submission.actionHistory,
        ...(submission.continuation ? { continuation: submission.continuation } : {}),
      }, (event) => {
        if (chat.submission?.id !== submission.id || typeof event.delta !== "string") return;
        const assistant = chat.messages.find((message) => message.id === submission.assistantId);
        if (!assistant) return;
        assistant.text += event.delta;
        scheduleSave(chat);
        broadcast({ event: "delta", messageId: assistant.id, delta: event.delta });
      }, submission.id);

      if (chat.submission?.id !== submission.id) return;
      if (response.result?.toolCall) {
        await handleToolCall(chat, submission, response.result.toolCall);
        return;
      }
      const assistant = chat.messages.find((message) => message.id === submission.assistantId);
      if (assistant) assistant.status = "complete";
      finishSubmission(chat, submission);
      issue = null;
      await publish(chat);
    } catch (error) {
      if (error?.code === "model_context_lost" && !submission.continuation &&
          !submission.contextFallbackUsed && chat.submission?.id === submission.id) {
        chat.compaction = null;
        submission.contextFallbackUsed = true;
        submission.compactionChecked = true;
        await save(chat);
        if (chat.submission?.id === submission.id) void streamSubmission(chat, submission);
        return;
      }
      await failSubmission(chat, submission.id, error);
    }
  }

  async function resumeRetry() {
    const chat = await loadChat();
    const submission = chat.submission;
    if (!submission || submission.phase !== "waiting_connection" || connection.phase !== "ready") return;
    submission.phase = "preparing";
    await publish(chat);
    void prepareSubmission(chat, submission);
  }

  async function prepareSubmission(chat, submission) {
    if (chat.submission?.id !== submission.id) return;
    try {
      const context = await captureForSubmission(chat, submission);
      if (!context || chat.submission?.id !== submission.id) return;
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
        user.context = context;
        assistant.text = "";
        assistant.status = "streaming";
        assistant.error = null;
        assistant.stale = false;
        assistant.actions = [];
      } else {
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
          actions: [],
          createdAt: Date.now(),
        };
        chat.messages.push(user, assistant);
      }

      submission.userId = user.id;
      submission.assistantId = assistant.id;
      submission.phase = "streaming";
      await publish(chat);
      void streamSubmission(chat, submission);
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
    if (connection.phase !== "ready") throw {
      code: "connection_not_ready",
      message: "Finish connecting BrowseFriend before sending a message.",
      retryable: true,
    };

    issue = issue?.scope === "generation" ? null : issue;
    const submission = {
      id,
      text: prompt,
      phase: "preparing",
      mode: chat.mode,
      actionCount: 0,
      actionHistory: [],
      continuation: null,
      lastActionFingerprint: null,
      pendingAction: null,
      actionExecuted: false,
      tabId: null,
      startOrigin: null,
      currentOrigin: null,
      currentUrl: null,
    };
    chat.submission = submission;
    await publish(chat);
    void prepareSubmission(chat, submission);
    return publicState(chat);
  }

  async function setMode(mode) {
    const chat = await loadChat();
    if (!["ask", "act"].includes(mode)) throw {
      code: "invalid_request",
      message: "Choose Ask or Act mode.",
      retryable: false,
    };
    if (chat.submission) throw {
      code: "model_busy",
      message: "Stop the current response before changing modes.",
      retryable: true,
    };
    if (mode === "ask") {
      chat.mode = "ask";
      chat.authorization = null;
      await publish(chat);
      return publicState(chat);
    }

    const page = await pageReader.capture();
    const context = contextFor(page);
    const origin = context.available ? pageOrigin(context.url) : null;
    if (!context.available || !origin) throw {
      code: context.error?.code || "page_unavailable",
      message: context.error?.message || "Act mode is unavailable on this page.",
      retryable: false,
    };
    chat.mode = "act";
    chat.authorization = { tabId: context.tabId, origin };
    await publish(chat);
    return publicState(chat);
  }

  async function resolveAction(id, approved) {
    const chat = await loadChat();
    const submission = chat.submission;
    const pending = submission?.pendingAction;
    if (!submission || !["waiting_confirmation", "waiting_file"].includes(submission.phase) ||
        !pending || pending.id !== id) {
      throw {
        code: "action_unavailable",
        message: "That action is no longer awaiting confirmation.",
        retryable: false,
      };
    }
    const assistant = assistantFor(chat, submission);
    const action = assistant?.actions?.find((item) => item.id === id);
    if (submission.phase === "waiting_file" && approved) {
      throw {
        code: "action_unavailable",
        message: "Choose the file in the page, or cancel this action.",
        retryable: false,
      };
    }
    if (!approved) {
      if (submission.phase === "waiting_file") {
        void Promise.resolve(pageActor.cancelFile?.(pending.context)).catch(() => undefined);
      }
      if (action) action.status = "cancelled";
      if (assistant) assistant.status = "stopped";
      finishSubmission(chat, submission);
      issue = null;
      await publish(chat);
      return publicState(chat);
    }

    try {
      const prepared = await pageActor.prepare(pending.call, pending.context);
      if (chat.submission?.id !== submission.id) return publicState(chat);
      if (action) action.status = "running";
      submission.phase = "executing";
      submission.pendingAction = null;
      await publish(chat);
      await executePageAction(chat, submission, pending.call, prepared, action);
      return publicState(chat);
    } catch (error) {
      await failSubmission(chat, submission.id, error);
      return publicState(chat);
    }
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
    const draft = submission.actionExecuted ? null : submission.text;
    const assistant = chat.messages.find((message) => message.id === submission.assistantId);
    const pendingAction = assistant?.actions?.find((action) => action.id === submission.pendingAction?.id);
    if (pendingAction) pendingAction.status = "cancelled";
    if (submission.phase === "waiting_file") {
      void Promise.resolve(pageActor.cancelFile?.(submission.pendingAction?.context)).catch(() => undefined);
    }
    if (assistant?.status === "streaming") {
      assistant.status = "stopped";
      assistant.error = null;
    }
    finishSubmission(chat, submission);
    if (issue?.scope === "generation") issue = null;
    await publish(chat);
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
      const submission = {
        id: randomUUID(),
        text: retryIssue.prompt,
        phase: connection.phase === "ready" ? "preparing" : "waiting_connection",
        retryAssistantId: retryIssue.assistantId,
        mode: chat.mode,
        actionCount: 0,
        actionHistory: [],
        continuation: null,
        lastActionFingerprint: null,
        pendingAction: null,
        actionExecuted: false,
        tabId: null,
        startOrigin: null,
        currentOrigin: null,
        currentUrl: null,
      };
      chat.submission = submission;
      await publish(chat);
      if (submission.phase === "preparing") void prepareSubmission(chat, submission);
      else void ensureReady({ force: true });
      return publicState(chat);
    }
    issue = null;
    await publish(chat);
    void ensureReady({ force: true });
    return publicState(chat);
  }

  function signIn() {
    if (accountMutationPromise) return accountMutationPromise.then(() => signIn());
    if (signInPromise) return signInPromise;
    const request = (async () => {
      const chat = await loadChat();
      const epoch = ++connectionEpoch;
      chat.compaction = null;
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
        void resumeRetry();
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

  function signOut(method = "auth.signOut") {
    if (accountMutationPromise) return accountMutationPromise;
    const request = (async () => {
      const chat = await loadChat();
      ++connectionEpoch;
      const activeId = chat.submission?.id;
      if (activeId) await stop(activeId);
      try {
        const response = await companion.request(method);
        Object.assign(chat, emptyChat(null, randomUUID()));
        models = [];
        modelCatalogPromise = null;
        const auth = response.result || { state: "signed_out", profile: null };
        await setAuthOutcome(chat, auth);
        return { state: publicState(chat), warning: response.warning || null };
      } catch (error) {
        await failConnection(chat, error);
        throw error;
      }
    })();
    const tracked = request.finally(() => {
      if (accountMutationPromise === tracked) accountMutationPromise = null;
    });
    accountMutationPromise = tracked;
    return tracked;
  }

  function resetLogin() {
    if (!canResetSavedLogin(connection.error)) throw {
      code: "reset_not_available",
      message: "Saved login reset is only available for a damaged or unsupported credential record.",
      retryable: false,
    };
    return signOut("auth.reset");
  }

  async function clear() {
    const chat = await loadChat();
    const activeId = chat.submission?.id;
    if (activeId) await stop(activeId);
    const cleared = emptyChat(chat.model, randomUUID());
    chatPromise = Promise.resolve(cleared);
    await clearModelContext(chat);
    issue = issue?.scope === "generation" ? null : issue;
    await publish(cleared);
    return publicState(cleared);
  }

  pageActor?.onFileSelection?.((event) => {
    void (async () => {
      const chat = await loadChat();
      const submission = chat.submission;
      const pending = submission?.pendingAction;
      if (!submission || submission.phase !== "waiting_file" || !pending ||
          pending.context.tabId !== event.tabId || pending.context.documentId !== event.documentId ||
          pending.call.args.ref !== event.ref) return;
      const assistant = assistantFor(chat, submission);
      const action = assistant?.actions?.find((item) => item.id === pending.id);
      if (event.cancelled) {
        if (action) action.status = "cancelled";
        if (assistant) assistant.status = "stopped";
        finishSubmission(chat, submission);
        await publish(chat);
        return;
      }
      await continueAfterAction(chat, submission, pending.call, {
        ...pending.prepared,
        executed: true,
        waitingForUser: false,
        value: `${event.count} ${event.count === 1 ? "file" : "files"} selected`,
      }, action);
    })().catch(async (error) => {
      const chat = await loadChat();
      if (chat.submission) await failSubmission(chat, chat.submission.id, error);
    });
  });

  pageReader.onDirty((event) => {
    void (async () => {
      const chat = await loadChat();
      let changed = false;
      const authorized = chat.authorization;
      const nextOrigin = event.url ? pageOrigin(event.url) : null;
      const submission = chat.submission;
      const taskTabId = submission?.tabId || (submission?.mode === "act" ? authorized?.tabId : null);
      const switchedTabs = submission && Number.isInteger(taskTabId) && event.activated && event.tabId !== taskTabId;
      const changedLocation = submission && Number.isInteger(taskTabId) &&
        event.tabId === taskTabId && typeof event.url === "string" &&
        event.url !== submission.currentUrl;
      const actionNavigation = changedLocation && submission.phase === "executing";

      if (actionNavigation) {
        submission.currentUrl = event.url;
        submission.currentOrigin = nextOrigin;
        changed = true;
      } else if (switchedTabs || changedLocation) {
        if (changedLocation) {
          submission.currentUrl = event.url;
          submission.currentOrigin = nextOrigin;
        }
        chat.mode = "ask";
        chat.authorization = null;
        changed = true;
        const assistant = assistantFor(chat, submission);
        if (assistant) {
          assistant.status = "error";
          assistant.error = {
            code: "user_navigated",
            message: "Stopped because you navigated away.",
            retryable: false,
          };
        }
        finishSubmission(chat, submission);
      } else if (!submission) {
        const resetAct = chat.mode === "act" && authorized &&
          ((event.activated && event.tabId !== authorized.tabId) ||
           (event.tabId === authorized.tabId && nextOrigin && nextOrigin !== authorized.origin));
        if (resetAct) {
          chat.mode = "ask";
          chat.authorization = null;
          changed = true;
        }
      }
      for (let index = 0; index < chat.messages.length; index += 1) {
        const message = chat.messages[index];
        if (actionNavigation && message.id === submission.userId) continue;
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
      void loadChat().then((chat) => {
        chat.compaction = null;
        return failConnection(chat, event.error);
      });
      return;
    }
    if (event.type !== "auth.changed" || readinessPromise || signInPromise || accountMutationPromise) return;
    const auth = event.state;
    void loadChat().then((chat) => { chat.compaction = null; });
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
    if (message.method === "app.setMode") operation = setMode(message.mode);
    if (message.method === "app.resolveAction") operation = resolveAction(message.id, message.approved === true);
    if (message.method === "app.retry") operation = retry();
    if (message.method === "app.clear") operation = clear();
    if (message.method === "app.signIn") operation = signIn();
    if (message.method === "app.cancelSignIn") operation = cancelSignIn();
    if (message.method === "app.signOut") operation = signOut();
    if (message.method === "app.resetLogin") operation = Promise.resolve().then(resetLogin);
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
    resolveAction,
    setMode,
    signIn,
    stop,
    submit,
  };
}
