# Known Limitations

BrowseFriend requires a separately installed Go native companion. Its standalone binary needs
neither Node nor Go installed. Development still uses both toolchains for builds and tests.
The user reports successful use in Chrome on macOS ARM64. The companion supports one selected
registration. Windows 11 x64/ARM64 binaries and test suites are provided, with x64 compatibility
tested through Wine on macOS. Native Windows execution, Windows ARM64 execution, Windows security
enforcement, and manual Chrome browser checks remain pending. Wine results do not establish native
Windows support. CI is configured for all six native targets, but first hosted execution remains
pending until the initial push. Signed installers and account selection remain deferred.
See [Native companion](NATIVE_HOST.md) for the platform verification record.

Chrome communicates with the companion through Native Messaging over standard input/output; the
companion is not a permanent localhost service. **Continue with ChatGPT** temporarily opens a
random loopback listener only while completing the hosted OAuth callback.

## Credential storage

- Windows requires protected owner/SYSTEM ACLs. Safe inherited permissions or normal Administrators
  entries can cause a storage error. The companion no longer repairs existing ACLs automatically;
  the simpler policy remains deferred until native Windows validation.
- The context-aware go-keyring fork cancels macOS commands and Linux waits, but cancellation cannot
  undo an OS-accepted write. Windows Credential Manager calls do not prompt and normally finish
  synchronously; they cannot be interrupted or given a guaranteed hard deadline. Linux uses a
  `plain` Secret Service session on local D-Bus; this concerns transport, not plaintext disk storage.
- The [storage evaluation](STORAGE_EVALUATION.md) found no clear database replacement for the single
  encrypted account record. Keeper's fixed open timeout delays cancellation, and Chestnut needs a
  dependency replacement to compile. Those databases remain evaluation-only. The runtime now uses
  the context-aware keyring fork and `gofrs/flock`; their source pins and licenses are tracked.

The keyring fork remains based on reviewed upstream v0.2.8. The upstream checker reports conflicts
with newer unreleased changes; that manual sync is tracked in the [roadmap](TODO.md).

## Page understanding

- BrowseFriend reads ordinary HTTP and HTTPS top-level documents only. Chrome-internal pages,
  extension pages, file URLs without separate access, incognito pages without separate access, and
  embedded frames are unavailable in this version.
- Page context is derived from the rendered DOM and ARIA markup, not Chrome's computed
  accessibility tree. Canvas pixels, image-only content, closed shadow roots, CSS-only changes,
  and some custom controls may be missing or incomplete.
- BrowseFriend cannot send screenshots, page images, or user-selected files to the model. The
  current model transport supports text and typed tools; multimodal input remains future work.
- Required site access produces Chrome's broad read/change warning even though Ask mode does not
  intentionally modify pages.

## Page interaction

- Act mode controls ordinary top-level DOM elements only. Embedded frames, closed shadow roots,
  canvas controls, drag-and-drop, rich editors, and site-specific custom widgets may be unavailable.
- Scripted clicks and input events are not trusted browser input. Sites may ignore them, require a
  direct user gesture, or react differently from a physical click.
- BrowseFriend recaptures after every action and replans when the DOM changes, but it cannot observe
  network-idle state. `page_wait_for_change` waits five seconds; slower content may require another
  prompt.
- Direct navigation uses a model-selected HTTP(S) URL. BrowseFriend has no built-in web-search
  provider and cannot guarantee that a syntactically valid destination is the page the user meant.
  If several consequential targets remain ambiguous, the model may stop and explain the blocker.
- File selection always remains a direct user action. BrowseFriend highlights supported file inputs
  or associated labels and observes only the selected count. Some sites upload immediately after
  selection, before a later form submission confirmation.
- Download confirmation covers explicit and recognizable download links. Without Chrome's broad
  downloads permission, BrowseFriend cannot reliably detect, monitor, or cancel downloads started
  indirectly by page scripts or server response headers. Chrome remains responsible for saving the
  file, warnings, progress, cancellation, and completion.
- Consequential-action classification is conservative but cannot understand every custom site.
  Ambiguous buttons are confirmed; unsupported or sensitive targets fail closed.

## Chat behavior

- Automatic model selection uses the first model returned for the connected account. Reasoning uses
  each selected model's advertised default unless the user chooses one of its supported explicit
  levels. If the catalog omits reasoning metadata, BrowseFriend sends no override.
- Conversations use `store: false` and do not create ChatGPT history entries. They are held in
  Chrome's memory-only session storage and disappear after browser restart, extension reload,
  extension update, or disable.
- Transcript compaction is triggered by serialized byte size rather than the selected model's exact
  token count. BrowseFriend preserves the latest eight exchanges verbatim and excludes older action
  records; if the endpoint is unavailable or rejects its canonical output, it safely falls back to
  bounded raw history and may forget more of the oldest prose.
- The current transcript is global across open BrowseFriend panels and Chrome windows. Switching
  tabs or windows does not select a separate chat; use **New chat** to clear the shared context.
- Responses are based on a captured page revision. BrowseFriend reports when the page changes but
  does not restart an answer automatically.

Revisit these constraints when multimodal transport, a supported pure-extension authentication flow, or packaged installers become available.
