// Keep DOM lookups together so the rest of the file reads like a small controller.
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
const messageTemplate = document.querySelector("#message-template");
const suggestionButtons = document.querySelectorAll(".suggestion");

const PLAN_WELCOME_KEY = "browsefriend.planWelcomeSeen";
let currentAuth = { state: "loading", profile: null, planUsageEnabled: false };

function addMessage(text, role) {
  const fragment = messageTemplate.content.cloneNode(true);
  const message = fragment.querySelector(".message");
  const avatar = fragment.querySelector(".message__avatar");
  const content = fragment.querySelector(".message__content");

  message.classList.add(`message--${role}`);
  avatar.textContent = role === "user" ? "You" : "B";
  content.textContent = text; // textContent avoids interpreting user text as HTML.
  conversation.append(fragment);
  conversation.scrollTop = conversation.scrollHeight;
}

function resizeInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${messageInput.scrollHeight}px`;
}

function showSettings() {
  viewStack.classList.add("view-stack--settings");
  chatView.inert = true;
  chatView.setAttribute("aria-hidden", "true");
  settingsView.inert = false;
  settingsView.setAttribute("aria-hidden", "false");
  openSettingsButton.setAttribute("aria-expanded", "true");
  closeSettingsButton.focus({ preventScroll: true });
}

function showChat() {
  viewStack.classList.remove("view-stack--settings");
  settingsView.inert = true;
  settingsView.setAttribute("aria-hidden", "true");
  chatView.inert = false;
  chatView.setAttribute("aria-hidden", "false");
  openSettingsButton.setAttribute("aria-expanded", "false");
  openSettingsButton.focus({ preventScroll: true });
}

function setStatusMessage(element, error) {
  element.hidden = !error;
  element.textContent = error?.message || "";
}

function maybeShowPlanWelcome(previousState, nextState) {
  if (previousState === "signed_in" || nextState !== "signed_in" ||
      localStorage.getItem(PLAN_WELCOME_KEY) === "true") {
    return;
  }

  planWelcome.hidden = false;
  dismissPlanWelcomeButton.focus({ preventScroll: true });
}

function renderAuth(nextAuth, explicitError = null) {
  const previousState = currentAuth.state;
  currentAuth = nextAuth;
  const connected = ["signed_in", "plan_disabled"].includes(nextAuth.state);
  const ready = nextAuth.state !== "loading";
  const signedIn = nextAuth.state === "signed_in";
  const signingIn = nextAuth.state === "signing_in";
  const planDisabled = nextAuth.state === "plan_disabled";
  const error = explicitError || nextAuth.error || null;
  const companionUnavailable = ["companion_unavailable", "companion_timeout"].includes(error?.code);

  authLoading.hidden = ready;
  authView.hidden = !ready || signedIn;
  chatContent.hidden = !signedIn;
  clearButton.hidden = !signedIn;

  authTitle.textContent = planDisabled ? "Enable your ChatGPT plan" : "Connect BrowseFriend";
  authDescription.textContent = planDisabled
    ? "Your account is connected, but BrowseFriend needs permission to use your ChatGPT plan."
    : "Sign in to use your ChatGPT plan with this local browser companion.";
  signInButtonLabel.textContent = planDisabled ? "Enable ChatGPT plan" : "Continue with ChatGPT";
  signInButton.disabled = signingIn;
  settingsSignInButton.disabled = signingIn;
  cancelSignInButton.hidden = !signingIn;
  companionHelp.hidden = !companionUnavailable;
  setStatusMessage(authError, companionUnavailable ? null : error);

  const profileName = nextAuth.profile?.name || (connected ? "ChatGPT account" : "Not connected");
  const profileEmail = nextAuth.profile?.email ||
    (connected ? "Connected through OpenAI" : "Connect a ChatGPT account to continue.");
  accountName.textContent = profileName;
  accountEmail.textContent = profileEmail;
  accountStatus.textContent = signedIn
    ? "ChatGPT plan usage enabled"
    : planDisabled
      ? "Signed in — plan usage not enabled"
      : signingIn
        ? "Waiting for sign-in"
        : "Signed out";
  settingsSignInButton.hidden = signedIn;
  settingsSignInLabel.textContent = planDisabled ? "Enable ChatGPT plan" : "Continue with ChatGPT";
  manageUsageLink.hidden = !connected;
  signOutButton.hidden = !connected;
  setStatusMessage(settingsAuthError, error);

  maybeShowPlanWelcome(previousState, nextAuth.state);
}

async function requestAuth(method) {
  const response = await chrome.runtime.sendMessage({ channel: "auth", method });
  if (!response?.ok) throw response?.error || {
    code: "companion_unavailable",
    message: "The BrowseFriend companion is unavailable.",
    retryable: true,
  };
  return response;
}

async function refreshAuth() {
  renderAuth({ state: "loading", profile: null, planUsageEnabled: false });
  try {
    const response = await requestAuth("auth.status");
    renderAuth(response.result);
  } catch (error) {
    renderAuth({ state: "signed_out", profile: null, planUsageEnabled: false }, error);
  }
}

async function signIn() {
  renderAuth({ ...currentAuth, state: "signing_in", error: null });
  try {
    const response = await requestAuth("auth.signIn");
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
    const response = await requestAuth("auth.cancel");
    renderAuth(response.result);
  } catch (error) {
    renderAuth({ ...currentAuth, state: "signed_out" }, error);
  } finally {
    cancelSignInButton.disabled = false;
  }
}

function clearConversation() {
  conversation.querySelectorAll(".message").forEach((message) => message.remove());
  welcome.hidden = false;
  messageInput.value = "";
  resizeInput();
}

async function signOut() {
  signOutButton.disabled = true;
  try {
    const response = await requestAuth("auth.signOut");
    clearConversation();
    renderAuth(response.result, response.warning);
    showChat();
  } catch (error) {
    renderAuth(currentAuth, error);
  } finally {
    signOutButton.disabled = false;
  }
}

function submitMessage() {
  const message = messageInput.value.trim();

  if (!message) return;

  welcome.hidden = true;
  addMessage(message, "user");
  addMessage("Authentication is connected. Live chat plumbing comes next.", "assistant");
  messageInput.value = "";
  resizeInput();
  messageInput.focus();
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitMessage();
});

messageInput.addEventListener("input", resizeInput);

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitMessage();
  }
});

suggestionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    messageInput.value = button.textContent;
    resizeInput();
    messageInput.focus();
  });
});

clearButton.addEventListener("click", () => {
  clearConversation();
  messageInput.focus();
});

openSettingsButton.addEventListener("click", showSettings);
closeSettingsButton.addEventListener("click", showChat);
signInButton.addEventListener("click", signIn);
settingsSignInButton.addEventListener("click", signIn);
cancelSignInButton.addEventListener("click", cancelSignIn);
retryAuthButton.addEventListener("click", refreshAuth);
signOutButton.addEventListener("click", signOut);

dismissPlanWelcomeButton.addEventListener("click", () => {
  localStorage.setItem(PLAN_WELCOME_KEY, "true");
  planWelcome.hidden = true;
  messageInput.focus({ preventScroll: true });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.channel !== "auth") return;
  if (message.event === "changed") renderAuth(message.state);
  if (message.event === "disconnected") {
    renderAuth({ state: "signed_out", profile: null, planUsageEnabled: false }, message.error);
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

refreshAuth();
