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

A [DNR callback investigation](AUTH_DNR_INVESTIGATION.md) demonstrated synthetic redirection in
Brave/Chromium 156, but OpenAI support and browser-side token handling remain unverified. The selected
implementation retains Go and loopback OAuth. Credentials now persist in an owner-protected native
file and restore automatically across browser/companion restarts. The file is not application-encrypted;
its protection depends on OS access controls and any disk/backup encryption configured by the user.
Temporary network/storage errors preserve it; invalid renewable credentials require fresh sign-in.
Old encrypted files and keyring entries are ignored, without migration or cleanup tooling.
Stage 2 keeps opaque compaction payloads in a separate 320-KiB Go cache. Chrome retains handles,
byte counts, and checkpoints. Losing the companion also loses this context; recovery can use only
the bounded transcript prose still available in Chrome, and never replays Act actions.

Bundled OS scripts still need Native Messaging registration or independent server startup. A shared
interpreter can simplify explicit file cleanup, but does not make extension removal uninstall the
helper. Those alternatives are deferred. Setup, updates, and removal must work without administrator
access; per-user native registration already supports that requirement.

## Credential storage

- Windows requires protected owner/SYSTEM ACLs. Safe inherited permissions or normal Administrators
  entries can cause a storage error. The companion no longer repairs existing ACLs automatically;
  the simpler policy remains deferred until native Windows validation.
- Processes serialize account updates and share durable refresh checkpoints. A crash or storage
  failure before a rotating successor can be saved may still require fresh sign-in. In-memory
  recovery cannot survive process exit when no replacement was committed.
- Normal updates preserve the login. Confirmed reset and explicit uninstall clear local credentials;
  they do not confirm remote revocation. Log out or disconnect the app in ChatGPT Settings for that.
- The [storage evaluation](STORAGE_EVALUATION.md) archives retired persistence experiments. The
  current runtime has no keyring or database dependency; protected files store registration and credentials separately.

## Side-panel layout

Transcript font choices depend on fonts installed on the current computer. Default preserves the
inherited font and size, including browser extension-page defaults; Inter is not bundled. Missing
selected fonts use that fallback while retaining the preference; code fonts fall back to the system
monospace stack. Chrome's font list does not classify fonts as monospace, so the Code font selector
offers all installed fonts. A font-list failure leaves Default, size, and prompt emphasis controls
available and offers Retry. Browser zoom and minimum-font settings can affect the rendered sizes.

The panel uses ordinary responsive CSS within the browser-reported viewport. Clipping at very
narrow tiled browser widths is accepted behavior; BrowseFriend has no viewport compensation,
resize recovery, or window-manager integration for it.

A native Wayland reproduction used Brave 1.98.60 / Chromium 156 and Hyprland 0.56.2, with a
synthetic unpacked extension using the production panel assets. Hyprland allocated a 926px window,
and later a 600px window, while Brave's `window.outerWidth` remained 1072. The panel reported about
334 CSS pixels at device-pixel ratio 1.25. Compositor screenshots showed both Brave's toolbar and
the panel clipped on the right. Widening the actual window to 1200px restored the complete panel.
These are observed dimensions for that setup, not universal minimums.

The user also reproduced clipped headings and composer content in the separately installed
[Webbrain extension](https://github.com/webbrain-one/webbrain). Keeping the entire browser window
wide enough avoids the observed clipping. Reloading the extension is not a lasting fix.

One-off rendered-page checks passed 648 layout/navigation checks across 220–640px viewports,
both themes, and 16/20px text, but could not detect clipping outside the page's reported viewport.
Their investigation harness and speculative clipping adjustments were removed after identifying
this accepted browser limitation. Existing navigation tests remain. The X11 comparison and
production authentication integration were not completed by that probe.

Related firsthand reports describe the same class of viewport/surface mismatch:
[Brave and Vesktop under Hyprland](https://www.reddit.com/r/hyprland/comments/1lhl0c5/),
[T3 Code clipping below its 840px minimum](https://github.com/pingdotgg/t3code/issues/8849), and
[Codex reporting a 600px viewport inside a 508px tile](https://github.com/openai/codex/issues/40518).
These corroborate the failure pattern; they are not confirmed duplicates of BrowseFriend's
specific Brave setup or evidence of a released fix.

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
  records. Opaque payloads live only in Go memory; stale handles fall back once to available prose
  before a new provider request. If the endpoint is unavailable or rejects its canonical output, it safely falls back to
  bounded raw history and may forget more of the oldest prose.
- The dedicated `/responses/compact` route returned HTTP 401 `hardened_oauth_rule_missing` with
  the tested ChatGPT connection. BrowseFriend now uses documented in-band compaction on `/responses`,
  which returned reusable opaque checkpoints with the same OAuth scopes. Checkpointing requires an
  additional tool-free inference request; availability can still depend on the model. Missing,
  unsupported, cancelled, or malformed checkpoints retain existing context and bounded raw-history
  fallback. See [the evaluation record](EVALUATIONS.md#chatgpt-oauth-in-band-compaction).
- The current transcript is global across open BrowseFriend panels and Chrome windows. Switching
  tabs or windows does not select a separate chat; use **New chat** to clear the shared context.
- Responses are based on a captured page revision. BrowseFriend reports when the page changes but
  does not restart an answer automatically.

Revisit these constraints when multimodal transport, a supported pure-extension authentication flow, or packaged installers become available.

Instruction behavior is best-effort. [Act evaluations](EVALUATIONS.md) measure real-model decisions on controlled HTML, with fallible model grading; simulated DOM/layout/navigation coverage does not certify real Chrome UI or arbitrary websites.
The initial controlled Act evaluation did not demonstrate an improvement from the progress
instructions: both variants revisited the same source file until the evaluation budget expired.
Act now retains ordered page observations, canonical model outputs, and tool results for the current
task in Go memory. It does not carry them into later prompts. Context is capped at 8 MiB without
mid-task compaction; individual model context windows can impose a smaller effective limit. A
companion restart loses unfinished task context. Three paired fixture repetitions passed 9/9 tasks
with retention versus 0/9 previously under identical instructions. See [evaluations](EVALUATIONS.md#task-context-verification-record);
improved task memory does not guarantee that the model avoids all unproductive approaches.
