# BrowseFriend Roadmap

This file tracks deferred product work and investigation topics. Items here are not part of the
current implementation unless a task explicitly promotes them into scope.

## Page interaction

- [ ] Add a separate **Act mode** with allowlisted actions, stale-target validation, previews, and
  explicit confirmation for submissions, purchases, messages, account changes, and destructive
  operations.
- [ ] Add same-origin and permitted cross-origin iframe context with clear frame attribution.
- [ ] Evaluate an optional computed-accessibility-tree provider through Chrome DevTools Protocol;
  account for the `debugger` warning, attachment lifecycle, performance, and API stability.
- [ ] Add disabled-site and per-site settings before page scripts are injected.

## Visual context and OCR

- [ ] Add screenshot fallback when a supported multimodal model transport is available.
- [ ] Design a `/` command framework, including a future `/screenshot` command.
- [ ] Add optional screenshot-every-turn behavior globally and per site.
- [ ] Evaluate bundling the Tesseract executable with the native companion for local OCR.
- [ ] Evaluate Python plus `pytesseract` only if a bundled Python runtime provides broader value;
  prefer invoking Tesseract directly when OCR is the only requirement.
- [ ] Evaluate another local or remote vision/OCR model, including privacy, download size, latency,
  licensing, and offline behavior.

## Chat and models

- [ ] Add persistent local chat history and a UI for reopening and deleting prior chats.
- [ ] Add reasoning-effort selection when the pinned DevKit exposes the parameter and each model's
  supported effort values.
- [ ] Add model-directed context expansion when the supported DevKit exposes tool calling.

## Distribution and authentication

- [ ] Package the native companion and runtime for macOS and Linux so users do not install Node.
- [ ] Re-evaluate the native-companion requirement if OpenAI supports a secure pure-extension flow.
