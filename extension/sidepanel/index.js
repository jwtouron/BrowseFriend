import { createAppClient } from "../app/client.js";
import { createAuthView } from "../auth/view-model.js";
import { renderMarkdown } from "../chat/markdown.js";
import { composerShortcut, createPromptHistory } from "../chat/prompt-history.js";
import {
  applyAccent,
  applyTheme,
  createPreferences,
  normalizeModel,
  shouldShowPageContext,
} from "../settings/preferences.js";
import {
  normalizeReasoningPreference,
  reasoningEffortOptions,
  supportedReasoningEfforts,
} from "../../shared/reasoning.js";
import { deriveViewState } from "./view-state.js";

const topbar = document.querySelector(".topbar");
const conversation = document.querySelector("#conversation");
const welcome = document.querySelector("#welcome");
const connectionStatus = document.querySelector("#connection-status");
const connectionStatusLabel = document.querySelector("#connection-status-label");
const connectionNotice = document.querySelector("#connection-notice");
const connectionNoticeTitle = document.querySelector("#connection-notice-title");
const connectionNoticeMessage = document.querySelector("#connection-notice-message");
const companionHelp = document.querySelector("#companion-help");
const viewStack = document.querySelector("#view-stack");
const chatView = document.querySelector("#chat-view");
const settingsView = document.querySelector("#settings-view");
const composer = document.querySelector("#composer");
const modeSwitch = document.querySelector("#mode-switch");
const modeInputs = document.querySelectorAll('input[name="page-mode"]');
const messageInput = document.querySelector("#message-input");
const clearMessageButton = document.querySelector("#clear-message");
const sendMessageButton = document.querySelector("#send-message");
const stopResponseButton = document.querySelector("#stop-response");
const retryOperationButton = document.querySelector("#retry-operation");
const clearButton = document.querySelector("#clear-chat");
const openSettingsButton = document.querySelector("#open-settings");
const closeSettingsButton = document.querySelector("#close-settings");
const closeButton = document.querySelector("#close-panel");
const signInButton = document.querySelector("#sign-in");
const signInButtonLabel = signInButton.querySelector("span:last-child");
const cancelSignInButton = document.querySelector("#cancel-sign-in");
const settingsSignInButton = document.querySelector("#settings-sign-in");
const settingsSignInLabel = settingsSignInButton.querySelector("span:last-child");
const signOutButton = document.querySelector("#sign-out");
const manageUsageLink = document.querySelector("#manage-usage");
const accountName = document.querySelector("#account-name");
const accountEmail = document.querySelector("#account-email");
const accountStatus = document.querySelector("#account-status");
const settingsAuthError = document.querySelector("#settings-auth-error");
const modelSelect = document.querySelector("#model-select");
const modelSettingsError = document.querySelector("#model-settings-error");
const reasoningSelect = document.querySelector("#reasoning-select");
const reasoningSettingsError = document.querySelector("#reasoning-settings-error");
const themeSelect = document.querySelector("#theme-select");
const themeSettingsError = document.querySelector("#theme-settings-error");
const accentPicker = document.querySelector("#accent-picker");
const accentInputs = document.querySelectorAll('input[name="accent-color"]');
const accentSettingsError = document.querySelector("#accent-settings-error");
const debugModeSwitch = document.querySelector("#debug-mode");
const debugSettingsError = document.querySelector("#debug-settings-error");
const contextViewer = document.querySelector("#context-viewer");
const closeContextButton = document.querySelector("#close-context");
const contextSummary = document.querySelector("#context-summary");
const contextContent = document.querySelector("#context-content");
const actionConfirmation = document.querySelector("#action-confirmation");
const actionTitle = document.querySelector("#action-title");
const actionDescription = document.querySelector("#action-description");
const actionSite = document.querySelector("#action-site");
const actionTarget = document.querySelector("#action-target");
const actionValueRow = document.querySelector("#action-value-row");
const actionValue = document.querySelector("#action-value");
const confirmActionButton = document.querySelector("#confirm-action");
const cancelActionButton = document.querySelector("#cancel-action");
const messageTemplate = document.querySelector("#message-template");
const suggestionButtons = document.querySelectorAll(".suggestion");

const appClient = createAppClient(chrome.runtime);
const promptHistory = createPromptHistory();
const preferences = createPreferences({
  storageArea: chrome.storage.local,
  storageChanged: chrome.storage.onChanged,
});
let currentState = {
  connection: {
    phase: "checking",
    auth: { state: "loading", profile: null, planUsageEnabled: false },
    error: null,
  },
  issue: null,
  messages: [],
  model: null,
  models: [],
  modelPreference: "automatic",
  reasoningPreference: "model_default",
  submission: null,
  mode: "ask",
  authorization: null,
};
let optimisticSubmission = null;
let debugMode = false;
let theme = "system";
let accent = "blue";
let modelPreference = "automatic";
let reasoningPreference = "model_default";
let availableModels = [];
let preferencesLoaded = false;
let contextViewerOpen = false;
let actionModalOpen = false;
let settingsError = null;
let localRecovery = null;
const assistantSources = new WeakMap();

function displayError(error, fallback = "BrowseFriend could not continue.") {
  return {
    code: typeof error?.code === "string" ? error.code : "app_unavailable",
    message: typeof error?.message === "string" ? error.message : fallback,
    retryable: error?.retryable !== false,
  };
}

function createMessageElement(messageData) {
  const fragment = messageTemplate.content.cloneNode(true);
  const message = fragment.querySelector(".message");
  const author = fragment.querySelector(".message__author");
  const content = fragment.querySelector(".message__content");
  const contextButton = fragment.querySelector(".context-chip");
  const actions = fragment.querySelector(".message__actions");
  const status = fragment.querySelector(".message__status");

  message.dataset.messageId = messageData.id;
  message.classList.add(`message--${messageData.role}`);
  author.textContent = messageData.role === "user" ? "You:" : "BrowseFriend:";
  if (messageData.role === "assistant") {
    assistantSources.set(message, messageData.text);
    renderMarkdown(content, messageData.text);
    for (const action of messageData.actions || []) {
      const item = document.createElement("div");
      item.className = `message-action message-action--${action.status}`;
      const verb = {
        check: "Changed",
        click: "Clicked",
        disclosure: "Opened",
        download: "Clicked",
        file: "Selected files for",
        fill: "Filled",
        navigation: "Navigated to",
        scroll: "Scrolled",
        select: "Selected",
        submit: "Submitted",
        wait: "Waited for",
      }[action.kind] || "Used";
      item.textContent = `${verb} ${action.target}`;
      if (action.value !== undefined) item.textContent += ` · ${action.value}`;
      actions.append(item);
    }
    actions.hidden = actions.childElementCount === 0;
  } else {
    content.textContent = messageData.text;
  }

  if (shouldShowPageContext(debugMode, messageData)) {
    contextButton.hidden = false;
    if (messageData.context.available && messageData.context.snapshot) {
      contextButton.textContent = `Page context · ${messageData.context.title || "Untitled page"}`;
      contextButton.addEventListener("click", () => showContext(messageData.context));
    } else if (messageData.context.available) {
      contextButton.textContent = `Page context expired · ${messageData.context.title || "Untitled page"}`;
      contextButton.disabled = true;
    } else {
      contextButton.textContent = `Page context unavailable · ${messageData.context.error?.message || "Unknown page"}`;
      contextButton.disabled = true;
    }
  }

  const statusText = messageData.status === "streaming" && !messageData.text
    ? "Thinking…"
    : messageData.status === "stopped"
      ? "Stopped"
      : messageData.status === "error"
        ? messageData.error?.message || "Response failed"
        : messageData.stale
          ? "The page changed after this context was captured."
          : "";
  status.hidden = !statusText;
  status.textContent = statusText;
  return fragment;
}

function appendDelta(messageId, delta) {
  const message = [...conversation.querySelectorAll(".message")]
    .find((element) => element.dataset.messageId === messageId);
  if (!message) return;
  const content = message.querySelector(".message__content");
  const status = message.querySelector(".message__status");
  const source = `${assistantSources.get(message) || ""}${delta}`;
  assistantSources.set(message, source);
  renderMarkdown(content, source);
  status.hidden = true;
  conversation.scrollTop = conversation.scrollHeight;
}

function renderConnectionStatus() {
  const view = deriveViewState(currentState, optimisticSubmission);
  connectionStatus.className = `connection-status connection-status--${view.connectionTone}`;
  connectionStatus.title = view.connectionLabel;
  connectionStatusLabel.textContent = view.connectionLabel;
}

function renderNotice() {
  const notice = currentState.issue;
  connectionNotice.hidden = !notice;
  signInButton.hidden = true;
  retryOperationButton.hidden = true;
  cancelSignInButton.hidden = true;
  companionHelp.hidden = true;
  if (!notice) return;

  if (notice.kind === "action") {
    connectionNoticeTitle.textContent = notice.title;
    connectionNoticeMessage.textContent = notice.message;
    if (notice.action === "sign_in") {
      signInButton.hidden = false;
      signInButtonLabel.textContent = currentState.connection.phase === "plan_required"
        ? "Enable ChatGPT plan"
        : "Continue with ChatGPT";
    }
    if (notice.action === "cancel_sign_in") cancelSignInButton.hidden = false;
    return;
  }

  connectionNoticeTitle.textContent = notice.scope === "generation"
    ? "Response failed"
    : "BrowseFriend could not connect";
  connectionNoticeMessage.textContent = notice.error?.message || "BrowseFriend could not continue.";
  retryOperationButton.hidden = !notice.retry;
  companionHelp.hidden = !["companion_unavailable", "companion_timeout"]
    .includes(notice.error?.code);
}

function renderMessages() {
  conversation.querySelectorAll(".message").forEach((message) => message.remove());
  currentState.messages.forEach((message) => {
    conversation.insertBefore(createMessageElement(message), connectionNotice);
  });
  welcome.hidden = currentState.messages.length > 0 || !connectionNotice.hidden;
  promptHistory.sync(currentState.messages
    .filter((message) => message.role === "user")
    .map((message) => message.text));
  conversation.scrollTop = conversation.scrollHeight;
}

function composerBusy() {
  return deriveViewState(currentState, optimisticSubmission).busy;
}

function authBlocksComposer() {
  const view = deriveViewState(currentState, optimisticSubmission);
  return view.inputDisabled && !view.busy;
}

function renderComposer() {
  const view = deriveViewState(currentState, optimisticSubmission);
  messageInput.disabled = view.inputDisabled;
  sendMessageButton.hidden = view.sendHidden;
  stopResponseButton.hidden = view.stopHidden;
  clearMessageButton.hidden = messageInput.value.length === 0 || messageInput.disabled;
  suggestionButtons.forEach((button) => {
    button.disabled = messageInput.disabled;
  });
}

function renderMode() {
  const mode = currentState.mode === "act" ? "act" : "ask";
  const disabled = composerBusy();
  modeSwitch.disabled = disabled;
  modeInputs.forEach((input) => {
    input.checked = input.value === mode;
    input.disabled = disabled;
  });
}

function showActionModal() {
  const submission = currentState.submission;
  const pending = submission?.pendingAction;
  const waitingFile = submission?.phase === "waiting_file";
  const waitingConfirmation = submission?.phase === "waiting_confirmation";
  if (!pending || (!waitingFile && !waitingConfirmation)) {
    if (actionModalOpen) {
      actionModalOpen = false;
      actionConfirmation.hidden = true;
      if (!contextViewerOpen) {
        topbar.inert = false;
        viewStack.inert = false;
      }
    }
    return;
  }

  actionModalOpen = true;
  actionTitle.textContent = waitingFile ? "Choose a file on the page" : "Confirm page action";
  actionDescription.textContent = waitingFile
    ? "Use the highlighted page control to choose files. BrowseFriend will continue after the selection."
    : "BrowseFriend paused before an action that may have an external effect.";
  actionSite.textContent = currentState.authorization?.origin || "Current page";
  actionTarget.textContent = pending.prepared?.target || "Page control";
  const value = pending.prepared?.value;
  actionValueRow.hidden = value === undefined;
  actionValue.textContent = value === undefined ? "" : String(value);
  confirmActionButton.hidden = waitingFile;
  cancelActionButton.textContent = waitingFile ? "Cancel task" : "Cancel";
  topbar.inert = true;
  viewStack.inert = true;
  actionConfirmation.hidden = false;
  requestAnimationFrame(() => (waitingFile ? cancelActionButton : confirmActionButton).focus({ preventScroll: true }));
}

function renderAccount() {
  const view = createAuthView(currentState.connection.auth, settingsError);
  accountName.textContent = view.profileName;
  accountEmail.textContent = view.profileEmail;
  accountStatus.textContent = view.accountStatus;
  settingsSignInButton.hidden = view.signedIn;
  settingsSignInButton.disabled = view.signingIn;
  settingsSignInLabel.textContent = view.signInLabel;
  manageUsageLink.hidden = !view.connected;
  signOutButton.hidden = !view.connected;
  setStatusMessage(settingsAuthError, settingsError);
  clearButton.hidden = !view.signedIn;
}

function renderModelsFromState() {
  const nextModels = Array.isArray(currentState.models) ? currentState.models : [];
  populateModels(nextModels, modelPreference);
  modelSelect.disabled = currentState.connection.phase !== "ready" || !nextModels.length;
  void reconcileReasoningPreference();
}

function renderApp(state, {
  restoreCompletionFocus = true,
  preserveLocalRecovery = false,
} = {}) {
  const previousSubmission = currentState.submission;
  const previousView = deriveViewState(currentState, optimisticSubmission);
  currentState = state;
  if (!preserveLocalRecovery) localRecovery = null;
  if (optimisticSubmission && state.submission?.id === optimisticSubmission.id) {
    optimisticSubmission = null;
  }
  renderConnectionStatus();
  renderNotice();
  renderMessages();
  renderComposer();
  renderMode();
  showActionModal();
  renderAccount();
  renderModelsFromState();

  if (!restoreCompletionFocus || !document.hasFocus() ||
      viewStack.classList.contains("view-stack--settings") || contextViewerOpen || actionModalOpen) return;

  const nextView = deriveViewState(currentState, optimisticSubmission);
  const submissionFinished = previousSubmission && !state.submission;
  const actionChanged = previousView.focusTarget !== nextView.focusTarget &&
    ["signIn", "cancelSignIn", "retry"].includes(nextView.focusTarget);
  if (submissionFinished || actionChanged) requestAnimationFrame(focusChatSurface);
}

function showOperationError(error, recovery, scope = "connection") {
  const publicError = displayError(error);
  localRecovery = recovery;
  const state = {
    ...currentState,
    connection: scope === "connection"
      ? { ...currentState.connection, phase: "error", error: publicError }
      : currentState.connection,
    issue: {
      kind: "error",
      scope,
      error: publicError,
      retry: recovery.type,
    },
  };
  renderApp(state, { preserveLocalRecovery: true });
}

function showContext(context) {
  if (!debugMode || !context?.snapshot) return;
  contextViewerOpen = true;
  topbar.inert = true;
  viewStack.inert = true;
  contextSummary.textContent = `${context.title || "Untitled page"} · revision ${context.revision}${context.stale ? " · page changed" : ""}`;
  contextContent.textContent = JSON.stringify(context.snapshot, null, 2);
  contextViewer.hidden = false;
  closeContextButton.focus({ preventScroll: true });
}

function hideContext({ restoreFocus = true } = {}) {
  if (!contextViewerOpen) return;
  contextViewerOpen = false;
  contextViewer.hidden = true;
  topbar.inert = false;
  viewStack.inert = false;
  if (restoreFocus) focusChatSurface();
}

function resizeInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${messageInput.scrollHeight}px`;
}

function updateComposerControls() {
  clearMessageButton.hidden = messageInput.value.length === 0 || messageInput.disabled;
}

function setComposerValue(value, { focus = false } = {}) {
  messageInput.value = value;
  resizeInput();
  updateComposerControls();
  if (focus && !messageInput.disabled) messageInput.focus({ preventScroll: true });
}

function clearComposer({ focus = true } = {}) {
  promptHistory.reset();
  setComposerValue("", { focus });
}

function focusChatSurface() {
  const targetName = deriveViewState(currentState, optimisticSubmission).focusTarget;
  const targets = {
    composer: messageInput,
    stop: stopResponseButton,
    signIn: signInButton,
    cancelSignIn: cancelSignInButton,
    retry: retryOperationButton,
  };
  let target = targets[targetName];
  if (!target || target.hidden || target.disabled) target = openSettingsButton;
  target.focus({ preventScroll: true });
}

function showSettings() {
  viewStack.classList.add("view-stack--settings");
  chatView.inert = true;
  chatView.setAttribute("aria-hidden", "true");
  settingsView.inert = false;
  settingsView.setAttribute("aria-hidden", "false");
  openSettingsButton.setAttribute("aria-expanded", "true");
  closeSettingsButton.focus({ preventScroll: true });
  if (currentState.connection.auth?.state === "signed_in") void refreshModels(true);
}

function showChat() {
  viewStack.classList.remove("view-stack--settings");
  settingsView.inert = true;
  settingsView.setAttribute("aria-hidden", "true");
  chatView.inert = false;
  chatView.setAttribute("aria-hidden", "false");
  openSettingsButton.setAttribute("aria-expanded", "false");
  requestAnimationFrame(focusChatSurface);
}

function setStatusMessage(element, error) {
  element.hidden = !error;
  element.textContent = error?.message || "";
}

function applyDebugMode(enabled) {
  const nextDebugMode = enabled === true;
  const changed = debugMode !== nextDebugMode;
  debugMode = nextDebugMode;
  debugModeSwitch.checked = debugMode;
  if (!debugMode && contextViewerOpen) hideContext({ restoreFocus: document.hasFocus() });
  if (changed) renderMessages();
}

function applyThemePreference(nextTheme) {
  theme = applyTheme(document.documentElement, nextTheme);
  themeSelect.value = theme;
}

function applyAccentPreference(nextAccent) {
  accent = applyAccent(document.documentElement, nextAccent);
  accentInputs.forEach((input) => {
    input.checked = input.value === accent;
  });
}

function hasModelOption(value) {
  return [...modelSelect.options].some((option) => option.value === value);
}

function applyModelPreference(nextModel) {
  modelPreference = normalizeModel(nextModel);
  if (hasModelOption(modelPreference)) modelSelect.value = modelPreference;
  populateReasoningEfforts();
}

function applyReasoningPreference(nextReasoningEffort) {
  reasoningPreference = normalizeReasoningPreference(nextReasoningEffort);
  populateReasoningEfforts();
}

function effectiveModel() {
  if (!availableModels.length) return null;
  if (modelPreference === "automatic") return availableModels[0];
  return availableModels.find((model) => model.slug === modelPreference) || availableModels[0];
}

function populateReasoningEfforts() {
  const model = effectiveModel();
  const options = reasoningEffortOptions(model).map(({ value, label }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  });
  reasoningSelect.replaceChildren(...options);
  reasoningSelect.value = options.some((option) => option.value === reasoningPreference)
    ? reasoningPreference
    : "model_default";
  reasoningSelect.disabled = !preferencesLoaded || currentState.connection.phase !== "ready" || !model;
}

async function reconcileReasoningPreference() {
  const model = effectiveModel();
  populateReasoningEfforts();
  if (!preferencesLoaded || !model || reasoningPreference === "model_default" ||
      supportedReasoningEfforts(model).includes(reasoningPreference)) return;

  const previous = reasoningPreference;
  reasoningPreference = "model_default";
  populateReasoningEfforts();
  setStatusMessage(reasoningSettingsError, null);
  try {
    await preferences.saveReasoningEffort("model_default");
  } catch {
    reasoningPreference = previous;
    populateReasoningEfforts();
    setStatusMessage(reasoningSettingsError, {
      message: "BrowseFriend could not reset the Reasoning effort preference.",
    });
  }
}

function populateModels(models, preference) {
  availableModels = models;
  const automaticOption = document.createElement("option");
  automaticOption.value = "automatic";
  automaticOption.textContent = "Automatic";
  const options = [automaticOption];
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.slug;
    option.textContent = model.displayName;
    options.push(option);
  }
  modelSelect.replaceChildren(...options);
  applyModelPreference(preference);
  populateReasoningEfforts();
}

async function refreshModels(refresh = true) {
  modelSelect.disabled = true;
  setStatusMessage(modelSettingsError, null);
  try {
    const result = await appClient.getModels(refresh);
    populateModels(result.models, result.preference);
    await reconcileReasoningPreference();
    modelSelect.disabled = currentState.connection.phase !== "ready" || !result.models.length;
    if (!result.models.length) {
      setStatusMessage(modelSettingsError, {
        message: "This ChatGPT account did not return an available model.",
      });
    }
  } catch (error) {
    availableModels = [];
    modelSelect.disabled = true;
    populateReasoningEfforts();
    setStatusMessage(modelSettingsError, error);
  }
}

async function loadPreferences() {
  debugModeSwitch.disabled = true;
  themeSelect.disabled = true;
  accentPicker.disabled = true;
  reasoningSelect.disabled = true;
  try {
    const stored = await preferences.load();
    applyDebugMode(stored.debugMode);
    applyThemePreference(stored.theme);
    applyAccentPreference(stored.accent);
    applyModelPreference(stored.model);
    applyReasoningPreference(stored.reasoningEffort);
    preferencesLoaded = true;
    await reconcileReasoningPreference();
  } catch {
    applyDebugMode(false);
    applyThemePreference("system");
    applyAccentPreference("blue");
    applyModelPreference("automatic");
    applyReasoningPreference("model_default");
    const error = { message: "BrowseFriend could not load saved settings." };
    setStatusMessage(debugSettingsError, error);
    setStatusMessage(themeSettingsError, error);
    setStatusMessage(accentSettingsError, error);
    setStatusMessage(reasoningSettingsError, error);
  } finally {
    debugModeSwitch.disabled = false;
    themeSelect.disabled = false;
    accentPicker.disabled = false;
    populateReasoningEfforts();
  }
}

async function updateDebugMode() {
  const requested = debugModeSwitch.checked;
  debugModeSwitch.disabled = true;
  setStatusMessage(debugSettingsError, null);
  try {
    applyDebugMode(await preferences.saveDebugMode(requested));
  } catch {
    debugModeSwitch.checked = debugMode;
    setStatusMessage(debugSettingsError, {
      message: "BrowseFriend could not save the Debug mode preference.",
    });
  } finally {
    debugModeSwitch.disabled = false;
  }
}

async function updateTheme() {
  const requested = themeSelect.value;
  themeSelect.disabled = true;
  setStatusMessage(themeSettingsError, null);
  try {
    applyThemePreference(await preferences.saveTheme(requested));
  } catch {
    themeSelect.value = theme;
    setStatusMessage(themeSettingsError, {
      message: "BrowseFriend could not save the Theme preference.",
    });
  } finally {
    themeSelect.disabled = false;
  }
}

async function updateAccent() {
  const requested = [...accentInputs].find((input) => input.checked)?.value;
  accentPicker.disabled = true;
  setStatusMessage(accentSettingsError, null);
  try {
    applyAccentPreference(await preferences.saveAccent(requested));
  } catch {
    applyAccentPreference(accent);
    setStatusMessage(accentSettingsError, {
      message: "BrowseFriend could not save the Accent color preference.",
    });
  } finally {
    accentPicker.disabled = false;
  }
}

async function updateModel() {
  const requested = modelSelect.value;
  modelSelect.disabled = true;
  setStatusMessage(modelSettingsError, null);
  try {
    applyModelPreference(await preferences.saveModel(requested));
    await reconcileReasoningPreference();
  } catch {
    modelSelect.value = hasModelOption(modelPreference) ? modelPreference : "automatic";
    setStatusMessage(modelSettingsError, {
      message: "BrowseFriend could not save the Model preference.",
    });
  } finally {
    modelSelect.disabled = currentState.connection.phase !== "ready" || !availableModels.length;
  }
}

async function updateReasoningEffort() {
  const requested = reasoningSelect.value;
  reasoningSelect.disabled = true;
  setStatusMessage(reasoningSettingsError, null);
  try {
    applyReasoningPreference(await preferences.saveReasoningEffort(requested));
  } catch {
    reasoningSelect.value = reasoningPreference;
    setStatusMessage(reasoningSettingsError, {
      message: "BrowseFriend could not save the Reasoning effort preference.",
    });
  } finally {
    populateReasoningEfforts();
  }
}

async function submitMessage() {
  const message = messageInput.value.trim();
  if (!message || composerBusy() || authBlocksComposer()) return;
  await submitText(message);
}

async function submitText(message) {
  const id = crypto.randomUUID();
  optimisticSubmission = { id, text: message };
  promptHistory.reset();
  setComposerValue("");
  renderComposer();
  try {
    renderApp(await appClient.submit(id, message), { restoreCompletionFocus: false });
  } catch (error) {
    optimisticSubmission = null;
    setComposerValue(message);
    renderComposer();
    showOperationError(error, { type: "submit", text: message }, "generation");
  }
}

async function stopSubmission() {
  const pending = optimisticSubmission || currentState.submission;
  if (!pending) return;
  const fallbackDraft = pending.text;
  try {
    const result = await appClient.stop(pending.id);
    optimisticSubmission = null;
    renderApp(result.state, { restoreCompletionFocus: false });
    if (result.draft !== null) setComposerValue(result.draft || fallbackDraft, { focus: true });
    else focusChatSurface();
  } catch (error) {
    optimisticSubmission = null;
    setComposerValue(fallbackDraft, { focus: true });
    renderComposer();
    showOperationError(error, { type: "start" });
  }
}

async function updateMode(mode) {
  if (composerBusy() || !["ask", "act"].includes(mode)) return;
  modeInputs.forEach((input) => { input.disabled = true; });
  try {
    renderApp(await appClient.setMode(mode), { restoreCompletionFocus: false });
    messageInput.focus({ preventScroll: true });
  } catch (error) {
    renderMode();
    showOperationError(error, { type: "mode", mode }, "generation");
  }
}

async function resolveAction(approved) {
  const pending = currentState.submission?.pendingAction;
  if (!pending) return;
  confirmActionButton.disabled = true;
  cancelActionButton.disabled = true;
  try {
    renderApp(await appClient.resolveAction(pending.id, approved), { restoreCompletionFocus: false });
  } catch (error) {
    showOperationError(error, { type: "start" }, "generation");
  } finally {
    confirmActionButton.disabled = false;
    cancelActionButton.disabled = false;
  }
}

async function signIn() {
  settingsError = null;
  try {
    renderApp(await appClient.signIn(), { restoreCompletionFocus: false });
  } catch (error) {
    showChat();
    showOperationError(error, { type: "signIn" });
  }
}

async function cancelSignIn() {
  if (cancelSignInButton.disabled) return;
  cancelSignInButton.disabled = true;
  try {
    renderApp(await appClient.cancelSignIn(), { restoreCompletionFocus: false });
  } catch (error) {
    showOperationError(error, { type: "cancelSignIn" });
  } finally {
    cancelSignInButton.disabled = false;
  }
}

async function retryOperation() {
  if (retryOperationButton.disabled) return;
  retryOperationButton.disabled = true;
  const recovery = localRecovery;
  localRecovery = null;
  try {
    if (recovery) {
      const connection = recovery.type === "start"
        ? { ...currentState.connection, phase: "checking", error: null }
        : currentState.connection;
      renderApp(
        { ...currentState, connection, issue: null },
        { restoreCompletionFocus: false },
      );
    }
    if (recovery?.type === "submit") {
      await submitText(recovery.text);
      return;
    }
    if (recovery?.type === "signIn") {
      await signIn();
      return;
    }
    if (recovery?.type === "cancelSignIn") {
      await cancelSignIn();
      return;
    }
    if (recovery?.type === "clear") {
      await clearConversation();
      return;
    }
    if (recovery?.type === "mode") {
      await updateMode(recovery.mode);
      return;
    }
    if (recovery?.type === "start") {
      renderApp(await appClient.start(), { restoreCompletionFocus: false });
      return;
    }
    renderApp(await appClient.retry(), { restoreCompletionFocus: false });
  } catch (error) {
    showOperationError(error, recovery || { type: "start" });
  } finally {
    retryOperationButton.disabled = false;
  }
}

async function clearConversation() {
  renderApp(await appClient.clear(), { restoreCompletionFocus: false });
  clearComposer({ focus: false });
}

async function signOut() {
  signOutButton.disabled = true;
  settingsError = null;
  try {
    const result = await appClient.signOut();
    if (result.warning) settingsError = result.warning;
    renderApp(result.state, { restoreCompletionFocus: false });
    clearComposer({ focus: false });
    showChat();
  } catch (error) {
    settingsError = error;
    setStatusMessage(settingsAuthError, error);
  } finally {
    signOutButton.disabled = false;
  }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitMessage();
});

messageInput.addEventListener("input", () => {
  promptHistory.reset();
  resizeInput();
  updateComposerControls();
});

messageInput.addEventListener("keydown", (event) => {
  const shortcut = composerShortcut(event);
  if (shortcut === "clear") {
    event.preventDefault();
    clearComposer();
    return;
  }
  if (shortcut === "previous" || shortcut === "next") {
    const value = shortcut === "previous"
      ? promptHistory.previous(messageInput.value)
      : promptHistory.next();
    if (value !== null) {
      event.preventDefault();
      setComposerValue(value, { focus: true });
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submitMessage();
  }
});

suggestionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    promptHistory.reset();
    setComposerValue(button.textContent, { focus: true });
  });
});

clearMessageButton.addEventListener("click", () => clearComposer());
clearButton.addEventListener("click", () => {
  hideContext();
  void clearConversation()
    .then(() => messageInput.focus())
    .catch((error) => showOperationError(error, { type: "clear" }, "generation"));
});
stopResponseButton.addEventListener("click", () => void stopSubmission());
modeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) void updateMode(input.value);
  });
});
confirmActionButton.addEventListener("click", () => void resolveAction(true));
cancelActionButton.addEventListener("click", () => void resolveAction(false));
retryOperationButton.addEventListener("click", () => void retryOperation());
openSettingsButton.addEventListener("click", showSettings);
closeSettingsButton.addEventListener("click", showChat);
signInButton.addEventListener("click", () => void signIn());
settingsSignInButton.addEventListener("click", () => void signIn());
cancelSignInButton.addEventListener("click", () => void cancelSignIn());
signOutButton.addEventListener("click", () => void signOut());
modelSelect.addEventListener("change", () => void updateModel());
reasoningSelect.addEventListener("change", () => void updateReasoningEffort());
themeSelect.addEventListener("change", () => void updateTheme());
accentInputs.forEach((input) => {
  input.addEventListener("change", () => void updateAccent());
});
debugModeSwitch.addEventListener("change", () => void updateDebugMode());
closeContextButton.addEventListener("click", hideContext);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && contextViewerOpen) hideContext();
  if (event.key === "Escape" && actionModalOpen) void resolveAction(false);
  if (event.key === "Tab" && actionModalOpen) {
    const buttons = [cancelActionButton, confirmActionButton]
      .filter((button) => !button.hidden && !button.disabled);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement);
    const next = event.shiftKey
      ? (index <= 0 ? buttons.length - 1 : index - 1)
      : (index < 0 || index === buttons.length - 1 ? 0 : index + 1);
    event.preventDefault();
    buttons[next].focus({ preventScroll: true });
  }
});

appClient.subscribe((event) => {
  if (event.event === "state") renderApp(event.state);
  if (event.event === "delta") appendDelta(event.messageId, event.delta);
});

preferences.subscribe((update) => {
  if (Object.hasOwn(update, "debugMode")) applyDebugMode(update.debugMode);
  if (Object.hasOwn(update, "theme")) applyThemePreference(update.theme);
  if (Object.hasOwn(update, "accent")) applyAccentPreference(update.accent);
  if (Object.hasOwn(update, "model")) {
    applyModelPreference(update.model);
    void reconcileReasoningPreference();
  }
  if (Object.hasOwn(update, "reasoningEffort")) {
    applyReasoningPreference(update.reasoningEffort);
    void reconcileReasoningPreference();
  }
});

closeButton.addEventListener("click", async () => {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (typeof currentWindow.id !== "number") throw new Error("Chrome did not return a window ID.");
    await chrome.sidePanel.close({ windowId: currentWindow.id });
  } catch (error) {
    console.error("Unable to close the side panel.", error);
  }
});

void loadPreferences();
void appClient.getState()
  .then((state) => {
    renderApp(state, { restoreCompletionFocus: false });
    return appClient.start();
  })
  .then((state) => renderApp(state, { restoreCompletionFocus: false }))
  .catch((error) => {
    showOperationError(error, { type: "start" });
  });
