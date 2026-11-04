# BrowseFriend Roadmap

This file tracks deferred product work and investigation topics. Items here are not part of the
current implementation unless a task explicitly promotes them into scope.

## Page interaction

- [x] Preserve task-scoped model outputs, observations, and tool results in native memory. Controlled
  context comparisons passed 9/9 tasks versus 0/9 previously; see [Act evaluations](EVALUATIONS.md).
- [ ] Expand Act evaluations beyond the initial repository fixtures and investigate remaining
  unproductive approaches. Keep semantic progress judgments model-owned; broader cycle detection
  stays deferred until evidence warrants it. Preserve failing traces.
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
- [ ] Confirm supported compaction access for ChatGPT OAuth and rerun the preserved native-cache
  comparison with fixed fixtures/model/effort and three repetitions. The tested connection returned
  HTTP 401 `hardened_oauth_rule_missing`; streaming and bounded raw-history fallback worked.

## Distribution and authentication

End-user setup, updates, and removal must work without administrator access. Any future runtime
prerequisite must support a user-owned installation rather than requiring a system-wide installer.

- [x] Evaluate OS-keyring libraries, encrypted stores, and a simpler Windows permission policy;
  archive the historical results in [Storage evaluation](STORAGE_EVALUATION.md).
- [x] Replace custom OS-key adapters with context-aware keyring APIs, lock-scoped account/key
  ownership, and validated `gofrs/flock` locking; preserve refresh checkpoints and cancellation boundaries.
- [x] Publish the reviewed `jwtouron/go-keyring` fork, previously pin its remote revision in both modules, and
  enable native CI and weekly/manual upstream-update PRs. All six fork native targets passed; see [CI](CI.md).
- [x] Merge unreleased Zalando changes through `66b55cc` (`ListUsers` and Secret Service content-type
  detection), retain context cancellation and the fork's CI, and update both BrowseFriend pins to
  `1a3d07a` after all six native targets pass. These completed keyring milestones are historical; Stage 1 retires the production dependency and
  experiment module.
- [ ] Validate safe inherited Windows ACLs natively before simplifying production acceptance checks.
  Existing unsafe ACLs are rejected rather than automatically repaired.
- [x] Replace the Node/SDK native runtime with the standalone Go companion and public OAuth/Responses flow.
- [x] Configure GitHub CI for **macOS ARM64, macOS x64, Linux ARM64, Linux x64, Windows x64,
  and Windows ARM64**, with simulated providers, temporary registration stores, production
  binary/installation checks, race tests where supported, and licensed development artifacts.
- [ ] After the initial push, confirm all six native CI jobs pass and record their actual platform
  results. Windows ARM64 has no Go race detector. Cross-compilation and Wine do not substitute for
  successful native execution.
- [ ] Run `tests/windows/verify.ps1` on native Windows for both architectures, including ACL/reparse
  enforcement and process-local authentication loss on restart; manually verify Chrome sign-in, Ask/Act, cancellation,
  restart, and logout. Wine compatibility coverage does not complete these checks.
- [ ] Add signed/notarized macOS and Linux installers, Windows signing/installers, and verify registration and sign-in after upgrades.
  Users must not need to install a language runtime.
- [ ] Add explicit account-selection support if multiple registrations become necessary.
- [x] Stage 1: retain Go Native Messaging and loopback OAuth, but hold credentials and refresh
  recovery only in process memory. Persist only non-secret registration identifiers. Keep npm/mise
  installation commands; remove credential encryption/keyring machinery without migration tooling.
  Automated verification passed; manual browser and unavailable platform checks remain pending.
- [x] Stage 2, after Stage 1 automated verification: move opaque compacted conversation context into a
  bounded native-memory cache. Keep only scoped handles, byte counts, and transcript checkpoints in
  Chrome; verify invalidation and restart recovery, and preserve a matching fixed-fixture real-model
  comparison. Automated results and any inconclusive live runs are recorded in [Act evaluations](EVALUATIONS.md).
- [ ] Publish versioned native companion GitHub releases with platform/architecture binaries,
  checksums, and required licenses. Existing workflow artifacts are not versioned releases.
- [ ] Once those releases exist, improve missing-helper detection and guide users to acquire and
  register the appropriate binary without administrator access. Guided installation is deferred;
  retain basic connection errors and npm/mise instructions for now.

The [DNR investigation](AUTH_DNR_INVESTIGATION.md) remains historical evidence. Extension-only auth,
shared-runtime native helpers, and moving captured-page archives out of Chrome are not selected.
