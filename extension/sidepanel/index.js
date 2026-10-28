import { createAuthClient } from "../auth/client.js";
import { createAuthView } from "../auth/view-model.js";
import { createChatClient } from "../chat/client.js";
import { renderMarkdown } from "../chat/markdown.js";
import { composerShortcut, createPromptHistory } from "../chat/prompt-history.js";
import {
  applyTheme,
  createPreferences,
  normalizeModel,
  shouldShowPageContext,
} from "../settings/preferences.js";
import { chatFocusTarget, shouldRestoreComposerFocus } from "./focus.js";

// Keep DOM lookups together so the rest of the file reads like a small controller.
const topbar = document.querySelector(".topbar");
const conversation = document.querySelector("#conversation");
const welcome = document.querySelector("#welcome");
const viewStack = document.querySelector("#view-stack");
const chatView = document.querySelector("#chat-view");
const settingsView = document.querySelector("#settings-view");
const authLoading = document.querySelector("#auth-loading");
const authView = document.querySelector("#auth-view");
const authTitle = document.querySelector("#auth-title");
const authDescription = document.querySelector("#auth-description");
const authError = document.querySelector("#auth-error");
const companionHelp = document.querySelector("#companion-help");
const chatContent = document.querySelector("#chat-content");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#message-input");
const clearMessageButton = document.querySelector("#clear-message");
const sendMessageButton = document.querySelector("#send-message");
const stopResponseButton = document.querySelector("#stop-response");
const chatError = document.querySelector("#chat-error");
const clearButton = document.querySelector("#clear-chat");
const openSettingsButton = document.querySelector("#open-settings");
const closeSettingsButton = document.querySelector("#close-settings");
const closeButton = document.querySelector("#close-panel");
const signInButton = document.querySelector("#sign-in");
const signInButtonLabel = signInButton.querySelector("span:last-child");
const cancelSignInButton = document.querySelector("#cancel-sign-in");
const retryAuthButton = document.querySelector("#retry-auth");
const settingsSignInButton = document.querySelector("#settings-sign-in");
const settingsSignInLabel = settingsSignInButton.querySelector("span:last-child");
const signOutButton = document.querySelector("#sign-out");
const manageUsageLink = document.querySelector("#manage-usage");
const accountName = document.querySelector("#account-name");
const accountEmail = document.querySelector("#account-email");
const accountStatus = document.querySelector("#account-status");
const settingsAuthError = document.querySelector("#settings-auth-error");
const planWelcome = document.querySelector("#plan-welcome");
const dismissPlanWelcomeButton = document.querySelector("#dismiss-plan-welcome");
const modelSelect = document.querySelector("#model-select");
const modelSettingsError = document.querySelector("#model-settings-error");
const themeSelect = document.querySelector("#theme-select");
const themeSettingsError = document.querySelector("#theme-settings-error");
const debugModeSwitch = document.querySelector("#debug-mode");
const debugSettingsError = document.querySelector("#debug-settings-error");
const contextViewer = document.querySelector("#context-viewer");
const closeContextButton = document.querySelector("#close-context");
const contextSummary = document.querySelector("#context-summary");
const contextContent = document.querySelector("#context-content");
const messageTemplate = document.querySelector("#message-template");
const suggestionButtons = document.querySelectorAll(".suggestion");

const PLAN_WELCOME_KEY = "browsefriend.planWelcomeSeen";
const authClient = createAuthClient(chrome.runtime);
const chatClient = createChatClient(chrome.runtime);
const promptHistory = createPromptHistory();
const preferences = createPreferences({
  storageArea: chrome.storage.local,
  storageChanged: chrome.storage.onChanged,
});
let currentAuth = { state: "loading", profile: null, planUsageEnabled: false };
let currentChat = { messages: [], model: null, generating: false, error: null };
let debugMode = false;
let theme = "system";
let modelPreference = "automatic";
let availableModels = [];
let modelLoadId = 0;
let planWelcomeOpen = false;
let contextViewerOpen = false;
const assistantSources = new WeakMap();

function createMessageElement(messageData) {
  const fragment = messageTemplate.content.cloneNode(true);
  const message = fragment.querySelector(".message");
  const avatar = fragment.querySelector(".message__avatar");
  const content = fragment.querySelector(".message__content");
  const contextButton = fragment.querySelector(".context-chip");
  const status = fragment.querySelector(".message__status");

  message.dataset.messageId = messageData.id;
  message.classList.add(`message--${messageData.role}`);
  avatar.textContent = messageData.role === "user" ? "You" : "B";
  if (messageData.role === "assistant") {
    assistantSources.set(message, messageData.text);
    renderMarkdown(content, messageData.text);
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

function renderChat(state) {
  const wasGenerating = currentChat.generating;
  currentChat = state;
  promptHistory.sync(state.messages
    .filter((message) => message.role === "user")
    .map((message) => message.text));
  conversation.querySelectorAll(".message").forEach((message) => message.remove());
  welcome.hidden = state.messages.length > 0;
  state.messages.forEach((message) => conversation.append(createMessageElement(message)));
  messageInput.disabled = state.generating;
  sendMessageButton.hidden = state.generating;
  stopResponseButton.hidden = !state.generating;
  clearButton.hidden = currentAuth.state !== "signed_in";
  chatError.hidden = !state.error;
  chatError.textContent = state.error?.message || "";
  conversation.scrollTop = conversation.scrollHeight;
  if (wasGenerating && !state.generating) {
    requestAnimationFrame(() => {
      if (shouldRestoreComposerFocus({
        wasGenerating,
        generating: currentChat.generating,
        documentHasFocus: document.hasFocus(),
        authState: currentAuth.state,
        settingsOpen: viewStack.classList.contains("view-stack--settings"),
        contextViewerOpen,
        planWelcomeOpen,
        chatVisible: !chatContent.hidden,
      })) {
        messageInput.focus({ preventScroll: true });
      }
    });
  }
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
  clearMessageButton.hidden = messageInput.value.length === 0;
}

function setComposerValue(value, { focus = false } = {}) {
  messageInput.value = value;
  resizeInput();
  updateComposerControls();
  if (focus) messageInput.focus({ preventScroll: true });
}

function clearComposer({ focus = true } = {}) {
  promptHistory.reset();
  setComposerValue("", { focus });
}

function focusChatSurface() {
  const targetName = chatFocusTarget({
    authState: currentAuth.state,
    generating: currentChat.generating,
  });
  const targets = {
    composer: messageInput,
    stop: stopResponseButton,
    signIn: signInButton,
    cancelSignIn: cancelSignInButton,
    settings: openSettingsButton,
  };
  const target = targets[targetName];
  if (!target || target.hidden || target.disabled) {
    openSettingsButton.focus({ preventScroll: true });
    return;
  }
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
  if (currentAuth.state === "signed_in") void refreshModels(true);
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
  if (!debugMode && contextViewerOpen) {
    hideContext({ restoreFocus: document.hasFocus() });
  }
  if (changed) renderChat(currentChat);
}

function applyThemePreference(nextTheme) {
  theme = applyTheme(document.documentElement, nextTheme);
  themeSelect.value = theme;
}

function hasModelOption(value) {
  return [...modelSelect.options].some((option) => option.value === value);
}

function applyModelPreference(nextModel) {
  modelPreference = normalizeModel(nextModel);
  if (hasModelOption(modelPreference)) modelSelect.value = modelPreference;
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
}

function resetModelsForAuth() {
  modelLoadId += 1;
  populateModels([], modelPreference);
  modelSelect.disabled = true;
  setStatusMessage(modelSettingsError, null);
}

async function refreshModels(refresh = true) {
  if (currentAuth.state !== "signed_in") {
    resetModelsForAuth();
    return;
  }
  const loadId = ++modelLoadId;
  modelSelect.disabled = true;
  setStatusMessage(modelSettingsError, null);
  try {
    const result = await chatClient.getModels(refresh);
    if (loadId !== modelLoadId || currentAuth.state !== "signed_in") return;
    populateModels(result.models, result.preference);
    modelSelect.disabled = result.models.length === 0;
    if (!result.models.length) {
      setStatusMessage(modelSettingsError, {
        message: "This ChatGPT account did not return an available model.",
      });
    }
  } catch (error) {
    if (loadId !== modelLoadId) return;
    availableModels = [];
    modelSelect.disabled = true;
    setStatusMessage(modelSettingsError, error);
  }
}

async function loadPreferences() {
  debugModeSwitch.disabled = true;
  themeSelect.disabled = true;
  setStatusMessage(debugSettingsError, null);
  setStatusMessage(themeSettingsError, null);
  try {
    const stored = await preferences.load();
    applyDebugMode(stored.debugMode);
    applyThemePreference(stored.theme);
    applyModelPreference(stored.model);
  } catch {
    applyDebugMode(false);
    applyThemePreference("system");
    applyModelPreference("automatic");
    setStatusMessage(debugSettingsError, {
      message: "BrowseFriend could not load saved settings.",
    });
    setStatusMessage(themeSettingsError, {
      message: "BrowseFriend could not load saved settings.",
    });
  } finally {
    debugModeSwitch.disabled = false;
    themeSelect.disabled = false;
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

async function updateModel() {
  const requested = modelSelect.value;
  modelSelect.disabled = true;
  setStatusMessage(modelSettingsError, null);
  try {
    applyModelPreference(await preferences.saveModel(requested));
  } catch {
    modelSelect.value = hasModelOption(modelPreference) ? modelPreference : "automatic";
    setStatusMessage(modelSettingsError, {
      message: "BrowseFriend could not save the Model preference.",
    });
  } finally {
    modelSelect.disabled = currentAuth.state !== "signed_in" || availableModels.length === 0;
  }
}

function maybeShowPlanWelcome(previousState, nextState) {
  if (previousState === "signed_in" || nextState !== "signed_in" ||
      localStorage.getItem(PLAN_WELCOME_KEY) === "true") {
    return;
  }

  planWelcomeOpen = true;
  topbar.inert = true;
  viewStack.inert = true;
  planWelcome.hidden = false;
  dismissPlanWelcomeButton.focus({ preventScroll: true });
}

function dismissPlanWelcome({ remember = true, restoreFocus = true } = {}) {
  if (!planWelcomeOpen) return;

  if (remember) localStorage.setItem(PLAN_WELCOME_KEY, "true");
  planWelcomeOpen = false;
  planWelcome.hidden = true;
  topbar.inert = false;
  viewStack.inert = false;

  if (!restoreFocus) return;

  if (viewStack.classList.contains("view-stack--settings")) {
    (signOutButton.hidden ? closeSettingsButton : signOutButton).focus({ preventScroll: true });
  } else {
    (currentAuth.state === "signed_in" ? messageInput : signInButton)
      .focus({ preventScroll: true });
  }
}

function renderAuth(nextAuth, explicitError = null) {
  const previousState = currentAuth.state;
  currentAuth = nextAuth;
  const closedPlanWelcome = planWelcomeOpen && nextAuth.state !== "signed_in";
  if (closedPlanWelcome) {
    dismissPlanWelcome({ remember: false, restoreFocus: false });
  }
  const view = createAuthView(nextAuth, explicitError);

  authLoading.hidden = view.ready;
  authView.hidden = !view.ready || view.signedIn;
  chatContent.hidden = !view.signedIn;
  clearButton.hidden = !view.signedIn;

  authTitle.textContent = view.authTitle;
  authDescription.textContent = view.authDescription;
  signInButtonLabel.textContent = view.signInLabel;
  signInButton.disabled = view.signingIn;
  settingsSignInButton.disabled = view.signingIn;
  cancelSignInButton.hidden = !view.signingIn;
  companionHelp.hidden = !view.companionUnavailable;
  setStatusMessage(authError, view.companionUnavailable ? null : view.error);

  accountName.textContent = view.profileName;
  accountEmail.textContent = view.profileEmail;
  accountStatus.textContent = view.accountStatus;
  settingsSignInButton.hidden = view.signedIn;
  settingsSignInLabel.textContent = view.signInLabel;
  manageUsageLink.hidden = !view.connected;
  signOutButton.hidden = !view.connected;
  setStatusMessage(settingsAuthError, view.error);

  if (nextAuth.state === "signed_in" && previousState !== "signed_in") {
    void refreshModels(true);
  } else if (nextAuth.state !== "signed_in") {
    resetModelsForAuth();
  }

  maybeShowPlanWelcome(previousState, nextAuth.state);

  if (closedPlanWelcome) {
    const focusTarget = viewStack.classList.contains("view-stack--settings")
      ? (view.ready && !view.signingIn ? settingsSignInButton : closeSettingsButton)
      : (view.signingIn ? cancelSignInButton : view.ready ? signInButton : openSettingsButton);
    focusTarget.focus({ preventScroll: true });
  }
}

async function refreshAuth() {
  renderAuth({ state: "loading", profile: null, planUsageEnabled: false });
  try {
    const response = await authClient.getStatus();
    renderAuth(response.result);
  } catch (error) {
    renderAuth({ state: "signed_out", profile: null, planUsageEnabled: false }, error);
  }
}

async function signIn() {
  renderAuth({ ...currentAuth, state: "signing_in", error: null });
  try {
    const response = await authClient.signIn();
    renderAuth(response.result, response.warning);
  } catch (error) {
    if (error.code === "cancelled") {
      await refreshAuth();
      return;
    }
    renderAuth({ ...currentAuth, state: currentAuth.profile ? "plan_disabled" : "signed_out" }, error);
  }
}

async function cancelSignIn() {
  cancelSignInButton.disabled = true;
  try {
    const response = await authClient.cancelSignIn();
    renderAuth(response.result);
  } catch (error) {
    renderAuth({ ...currentAuth, state: "signed_out" }, error);
  } finally {
    cancelSignInButton.disabled = false;
  }
}

async function clearConversation() {
  const state = await chatClient.clear();
  renderChat(state);
  clearComposer({ focus: false });
}

async function signOut() {
  signOutButton.disabled = true;
  try {
    const response = await authClient.signOut();
    await clearConversation().catch(() => undefined);
    renderAuth(response.result, response.warning);
    showChat();
  } catch (error) {
    renderAuth(currentAuth, error);
  } finally {
    signOutButton.disabled = false;
  }
}

async function submitMessage() {
  const message = messageInput.value.trim();

  if (!message || currentChat.generating) return;

  chatError.hidden = true;
  promptHistory.reset();
  setComposerValue("");
  try {
    const state = await chatClient.send(message);
    renderChat(state);
  } catch (error) {
    setComposerValue(message);
    chatError.hidden = false;
    chatError.textContent = error.message || "BrowseFriend could not send that message.";
  }
  if (!currentChat.generating) messageInput.focus({ preventScroll: true });
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
    .catch((error) => {
      chatError.hidden = false;
      chatError.textContent = error.message || "BrowseFriend could not clear this chat.";
    });
});
stopResponseButton.addEventListener("click", () => {
  void chatClient.cancel().catch((error) => {
    chatError.hidden = false;
    chatError.textContent = error.message || "BrowseFriend could not stop the response.";
  });
});

openSettingsButton.addEventListener("click", showSettings);
closeSettingsButton.addEventListener("click", showChat);
signInButton.addEventListener("click", signIn);
settingsSignInButton.addEventListener("click", signIn);
cancelSignInButton.addEventListener("click", cancelSignIn);
retryAuthButton.addEventListener("click", refreshAuth);
signOutButton.addEventListener("click", signOut);
modelSelect.addEventListener("change", () => void updateModel());
themeSelect.addEventListener("change", () => void updateTheme());
debugModeSwitch.addEventListener("change", () => void updateDebugMode());

dismissPlanWelcomeButton.addEventListener("click", () => dismissPlanWelcome());
closeContextButton.addEventListener("click", hideContext);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && contextViewerOpen) {
    hideContext();
    return;
  }
  if (event.key === "Escape" && planWelcomeOpen) dismissPlanWelcome();
});

authClient.subscribe((event) => {
  if (event.type === "changed") renderAuth(event.state);
  if (event.type === "disconnected") {
    renderAuth({ state: "signed_out", profile: null, planUsageEnabled: false }, event.error);
  }
});

chatClient.subscribe((event) => {
  if (event.event === "state") renderChat(event.state);
  if (event.event === "delta") appendDelta(event.messageId, event.delta);
});

preferences.subscribe((update) => {
  if (Object.hasOwn(update, "debugMode")) applyDebugMode(update.debugMode);
  if (Object.hasOwn(update, "theme")) applyThemePreference(update.theme);
  if (Object.hasOwn(update, "model")) {
    applyModelPreference(update.model);
    if (currentAuth.state === "signed_in" && !hasModelOption(modelPreference)) {
      void refreshModels(true);
    }
  }
});

closeButton.addEventListener("click", async () => {
  try {
    const currentWindow = await chrome.windows.getCurrent();

    if (typeof currentWindow.id !== "number") {
      throw new Error("Chrome did not return a window ID.");
    }

    await chrome.sidePanel.close({ windowId: currentWindow.id });
  } catch (error) {
    console.error("Unable to close the side panel.", error);
  }
});

void refreshAuth();
void loadPreferences();
void chatClient.getState()
  .then(renderChat)
  .catch((error) => {
    chatError.hidden = false;
    chatError.textContent = error.message || "BrowseFriend could not restore this chat.";
  });
