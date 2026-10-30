# Known Limitations

BrowseFriend requires a separately installed Go native companion. Its standalone binary needs
neither Node nor Go installed. Development still uses both toolchains for builds and tests.
The user reports successful use in Chrome on macOS ARM64. The companion supports one selected
registration. Signed/notarized installers, Windows support, account selection, and CI remain deferred.
See [Native companion](NATIVE_HOST.md) for the platform verification record.

Chrome communicates with the companion through Native Messaging over standard input/output; the
companion is not a permanent localhost service. **Continue with ChatGPT** temporarily opens a
random loopback listener only while completing the hosted OAuth callback.

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
