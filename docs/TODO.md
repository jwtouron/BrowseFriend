# BrowseFriend Roadmap

This file tracks deferred product work and investigation topics. Items here are not part of the
current implementation unless a task explicitly promotes them into scope.

## Page interaction

- [ ] Add a resumable Act clarification and choice flow that can preserve task context while the
  user resolves ambiguous targets, without weakening confirmation or stale-page safeguards.
- [ ] Add model-prompt file attachments with explicit previews, size/type limits, privacy controls,
  multimodal transport support, and no implicit reuse of files selected for web forms.
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

- [ ] Replace the single global transcript with persistent local chat history and explicit controls
  for creating, selecting, reopening, and deleting chats across the global side-panel experience.
- [ ] Add an **Instructions** Settings section before Debug. Keep additive instructions normally
  editable; show the base `BASE_MODEL_INSTRUCTIONS` text disabled until an **Edit** action presents and
  confirms a safety warning. Include **Reset to default**, persist both values in
  `chrome.storage.local`, synchronize panels, and keep consequential-action and page-data safety
  controls enforced in code rather than relying on editable instructions.
- [ ] Make the header connection indicator open **Settings → Account** and focus the account
  controls while preserving its non-color accessible status.
- [ ] Add reasoning-effort selection when the pinned DevKit exposes the parameter and each model's
  supported effort values.
- [ ] Add model-directed context expansion through the typed tool channel.

## Distribution and authentication

- [ ] Evaluate replacing the pinned DevKit and downstream tool patch with a direct implementation
  of OpenAI's documented local/open-source OAuth and Responses API flow. Preserve ID-token
  validation, refresh serialization, OS-backed credential protection, account lifecycle, typed
  tools, streaming, cancellation, error recovery, and the extension credential boundary.
- [ ] If the direct protocol proves suitable, prototype the native companion in Go and compare it
  with `deno compile` and Node single-executable packaging. Prefer a language-neutral source for
  shared tool schemas and require behavioral parity across Native Messaging, OAuth callbacks,
  model discovery, tool calls, streaming, cancellation, file locking, and platform credential-store
  commands. Compare macOS and Linux builds on x64 and ARM64, binary size, startup, and maintenance.
  Packaging must still provide host registration, installers, and macOS signing and notarization
  without requiring users to install a language runtime.
- [ ] Re-evaluate the native-companion requirement if OpenAI supports a secure pure-extension flow.
