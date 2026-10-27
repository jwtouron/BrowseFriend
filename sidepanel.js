// Keep DOM lookups together so the rest of the file reads like a small controller.
const conversation = document.querySelector("#conversation");
const welcome = document.querySelector("#welcome");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#message-input");
const clearButton = document.querySelector("#clear-chat");
const messageTemplate = document.querySelector("#message-template");
const suggestionButtons = document.querySelectorAll(".suggestion");

function addMessage(text, role) {
  const fragment = messageTemplate.content.cloneNode(true);
  const message = fragment.querySelector(".message");
  const avatar = fragment.querySelector(".message__avatar");
  const content = fragment.querySelector(".message__content");

  message.classList.add(`message--${role}`);
  avatar.textContent = role === "user" ? "You" : "S";
  content.textContent = text; // textContent avoids interpreting user text as HTML.
  conversation.append(fragment);
  conversation.scrollTop = conversation.scrollHeight;
}

function resizeInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${messageInput.scrollHeight}px`;
}

function submitMessage() {
  const message = messageInput.value.trim();

  if (!message) return;

  welcome.hidden = true;
  addMessage(message, "user");
  addMessage("The interface is ready. Connect a chat service here when you add the plumbing.", "assistant");
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
  conversation.querySelectorAll(".message").forEach((message) => message.remove());
  welcome.hidden = false;
  messageInput.value = "";
  resizeInput();
  messageInput.focus();
});
