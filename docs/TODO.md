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
  Define durable storage, migration, and deletion rules for model-specific compacted context without
  persisting page snapshots or obsolete action records.
- [ ] Add an **Instructions** Settings section before Debug. Keep additive instructions normally
  editable; show the base `baseInstructions` text from the shared contract disabled until an **Edit** action presents and
  confirms a safety warning. Include **Reset to default**, persist both values in
  `chrome.storage.local`, synchronize panels, and keep consequential-action and page-data safety
  controls enforced in code rather than relying on editable instructions.
- [ ] Make the header connection indicator open **Settings → Account** and focus the account
  controls while preserving its non-color accessible status.
- [ ] Add model-directed context expansion through the typed tool channel.

## Distribution and authentication

- [x] Replace the Node/SDK native runtime with the standalone Go companion and public OAuth/Responses flow.
- [x] Configure GitHub CI for **macOS ARM64, macOS x64, Linux ARM64, Linux x64, Windows x64,
  and Windows ARM64**, with simulated providers, isolated OS credential-store integration, production
  binary/installation checks, race tests where supported, and licensed development artifacts.
- [ ] After the initial push, confirm all six native CI jobs pass and record their actual platform
  results. Windows ARM64 has no Go race detector. Cross-compilation and Wine do not substitute for
  successful native execution.
- [ ] Run `tests/windows/verify.ps1` on native Windows for both architectures, including ACL/reparse
  enforcement and protected-key persistence; manually verify Chrome sign-in, Ask/Act, cancellation,
  restart, and logout. Wine compatibility coverage does not complete these checks.
- [ ] Add signed/notarized macOS and Linux installers, Windows signing/installers, and verify credential-store access after upgrades.
  Users must not need to install a language runtime.
- [ ] Add explicit account-selection support if multiple registrations become necessary.
- [ ] Re-evaluate the native-companion requirement if OpenAI supports a secure pure-extension flow.
