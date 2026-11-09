# BrowseFriend

BrowseFriend is a local-first Chrome side-panel companion. It provides a supported **Continue with ChatGPT** connection, a read-only Ask mode, and an explicit Act mode for validated page interaction.

## Authentication boundary

The extension never receives OAuth credentials. Its service worker talks to a native-messaging host
written in Go that runs OpenAI's loopback sign-in flow and returns only
display-safe account state. The companion saves tokens, profile details, and refresh checkpoints in
an owner-protected local file, restoring login automatically after browser or companion restart.
The file is not application-encrypted and requires no OS keyring. Separate registration metadata
retains the non-secret host, client, and account-subject identifiers.

BrowseFriend does not create product accounts, subscriptions, or billing. It does not read ChatGPT cookies, conversations, memory, or private endpoints. The official flow can use eligible ChatGPT plan usage but does not grant access to ChatGPT history or memory.

Model requests use `store: false`; BrowseFriend supplies only its fixed instructions, local transcript,
current page context, and current prompt. During one Act task, Go also retains earlier page
observations, model outputs, and tool results in memory, discarding them when the task ends. When reusable transcript context exceeds 256 KiB,
BrowseFriend requests an opaque checkpoint through OpenAI's streaming Responses API and keeps the latest eight exchanges
verbatim. Past page-action records are included only for those eight exchanges. The visible transcript
uses one global Chrome session shared by open panels. Opaque compacted
context stays in a separate Go memory cache capped at 320 KiB; Chrome stores only its handle, byte
count, and transcript checkpoint. New chat, effective model changes, and authentication changes
invalidate this context. Companion exit loses it; an expired handle falls back once to bounded
available transcript prose before any new model request. Act continuations use their existing
8-MiB task buffer and never restart actions to recover context. Chrome restart or extension reload
also clears the visible session.

## Prerequisites

- Google Chrome 141 or newer on macOS, desktop Linux, or Windows 11 (x64/ARM64).
- Node.js matching `^22.22.2 || ^24.15.0 || >=26.0.0` for JavaScript tests only.
- Go 1.25+ to build/test the companion; a C compiler for race tests.
- A ChatGPT account eligible for Sign in with ChatGPT plan usage.

BrowseFriend is a personal, local-first project. Its original code is [MIT licensed](LICENSE).
Dependencies and OpenAI sign-in artwork retain their separate terms; see [NOTICE.md](NOTICE.md).

## Install for development

```sh
go run ./native-host/cmd/build --check --install
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository. The checked-in manifest key gives development builds the stable ID expected by the native host. Reload the extension after code changes.

The installer copies the standalone binary into the application-data directory and registers it with Chrome. Moving the repository does not affect the installed copy. Unregister it with `go run ./native-host/cmd/build --check --uninstall`; saved login credentials are removed and non-secret registration data is preserved. Normal updates preserve the login.

On Windows, installation uses the current user's registry and needs no administrator access. Close
BrowseFriend before replacing or removing a running companion. A downloaded Windows executable can
register itself with `./browsefriend-native-host.exe install` after extracting the matching x64 or
ARM64 archive.

Windows x64 and ARM64 binaries are cross-compiled. Automated x64 compatibility tests run under Wine
on macOS. Native Windows testing, ARM64 runtime testing, and manual Chrome browser verification
remain pending; see the [verification record](docs/NATIVE_HOST.md#verification-record).

## Use

See [Native companion](docs/NATIVE_HOST.md) for standalone commands, storage locations, tests, and platform verification.

Open BrowseFriend from Chrome's toolbar. Chat appears immediately and Settings stays accessible.
The composer, suggested prompts, and Ask/Act controls stay disabled until the local companion,
authentication, and available models are ready. Yellow means connecting, green means ready, and
red means an action or retry is required.

Signed-out users see **Continue with ChatGPT** inside the chat. OpenAI handles account and workspace
selection in the browser, then returns to the local companion. Finishing sign-in enables the composer;
it never sends a draft automatically. **Settings → Account** shows the selected identity, plan-access
state, usage link, and logout action. Saved login restores automatically while renewable credentials
remain valid. Temporary network/storage failures preserve existing data and offer Retry. A damaged
or unsupported saved login exposes **Reset saved login** in Account settings, with confirmation;
reset keeps preferences and registration identifiers. Permission and disk-space errors must be fixed
before retrying. If saving a refresh replacement fails, the companion retains the replacement and
its account lock until Retry succeeds, local cleanup completes, or the process exits. Other companion
processes wait or report busy instead of replaying the spent token. Logout attempts remote revocation and clears local credentials; reset and uninstall
perform local cleanup only. Disconnect the app in ChatGPT Settings to revoke access separately.

Ask a question to capture the current HTTP or HTTPS page. BrowseFriend sends a bounded semantic snapshot—not raw HTML—and Debug mode can show the inspectable context attachment beside the message. If the page changes during generation, the completed answer is marked as stale. **New chat** asks for confirmation before clearing the memory-only conversation and its compacted context.

Use the control above the composer to switch from **Ask** to **Act**. Act can still answer ordinary
questions, but it also lets the model request an allowlisted page tool. BrowseFriend performs one
validated action at a time and recaptures the page after each step, so dynamically revealed form
controls become available on the next step. The model can navigate the current tab to an HTTP or
HTTPS page, then continue the same task from the new semantic snapshot. The task keeps its original
Act authority until it finishes; if it ends on a different site, the panel returns to Ask.

Switching tabs or navigating manually while a response is active stops it with an explanation.
Outside an active task, switching tabs or sites, starting a New chat, logging out, or restarting
Chrome returns to Ask; returning to an earlier tab does not restore Act.

Submissions, detected downloads, ambiguous buttons, purchases, messages, account changes, and
destructive operations pause for confirmation. File controls pause and highlight the page control
so the user can choose files directly; BrowseFriend observes only the selected count. Stop restores
the prompt only if the task has not already changed the page.

Send changes to Stop while a response is preparing or generating. Stop restores the prompt as an
editable draft and preserves any partial answer as stopped. Connection and response failures share a
Retry action; retrying a response captures fresh page context and replaces the failed attempt. A
connection failure disables the composer without discarding its draft. If an extension message loses its
reply, Retry first reconciles the current state; it never automatically repeats a prompt or page action.

Appearance settings persist the System, Light, or Dark theme and one of seven accent colors; blue is
the default. **Prompt text** and **Response text** independently select an installed font and size,
with live samples. Sizes range from 8–24 px, plus 28, 32, and 36 px; Default preserves the existing
inherited font and size, shown in the Default labels. Prompt text also has Bold and Italic switches.
Response text has separate **Text font** and **Code font** choices, sharing one size for prose,
inline code, and code blocks. Code defaults to the system monospace stack; choose an installed
monospace font to customize it. Response Markdown keeps its emphasis.
These settings affect transcript text, including existing history, and are available before sign-in.
The `fontSettings` permission is used only to list installed fonts; browser-wide font settings are
not changed. Preferences persist locally and update other open panels.

Settings can also use the first available model automatically or persist an explicit
model choice. Reasoning effort defaults to the selected model's advertised default; its dropdown
then lists that model's supported explicit efforts from highest to lowest. Model and effort changes
apply to the next response and do not clear the current chat.

The chat footer shows the resolved model and effort expected for the next prompt. The **Automatic**
model option names the first listed model it currently resolves to. Select the footer summary to
open Model settings; use the warning icon beside it to review the page-context sharing notice.
Header text can shorten as the panel narrows, and header icons have consistent sizes. Settings
controls reflow, and long code or tables scroll within the transcript. Very narrow tiled Brave
windows can still clip the panel; see [known limitations](docs/KNOWN_LIMITATIONS.md#side-panel-layout).

With an empty composer, use Up or Ctrl+P to recall earlier prompts; continue with Up/Down or Ctrl+P/N. Typing starts a fresh draft. Use the × control or Ctrl+U to clear the composer.

If the panel reports that the companion is unavailable, rerun `npm run install:host`, reload the extension, and select **Retry**.

See [Act evaluations](docs/EVALUATIONS.md) for browser-free HTML simulation and real-model instruction and task-context comparisons. `npm run eval:act` always makes real model calls; ordinary verification uses scripted responses. Run `npm ci` before development checks.

## Development commands

```sh
npm test              # Run authentication, bridge, UI, and security tests.
npm run lint          # Check JavaScript syntax.
npm run verify        # Run all local syntax, test, and manifest checks.
npm run build:host    # Build the standalone companion.
npm run test:host     # Go race/vet checks and coverage.
npm run install:host  # Development shortcut for build + installation.
npm run test:windows:wine # Optional Windows x64 compatibility tests; requires Wine.
python3 -m json.tool manifest.json
```

Go-only builds use `go run ./native-host/cmd/build --check`. Add `--cross` to build macOS/Linux/Windows ARM64/x64 artifacts and compile Windows tests. The build emits `build/THIRD-PARTY-NOTICES.txt`; include it when sharing binaries. Node is used for development tests, not for the installed companion. Native Windows verification is prepared in `tests/windows/verify.ps1`; its execution is pending.

### Optional mise setup

If you use [mise](https://mise.jdx.dev/), the checked-in `mise.toml` selects the same Go and Node
versions as CI, plus actionlint for workflow checks. npm comes with Node; Go includes `gofmt` and
`go vet`. You can instead install the prerequisites yourself and use the Go/npm commands above.

```sh
mise trust
mise install
mise run deps       # npm ci --ignore-scripts
mise run verify     # npm run verify, including npm's pretest hook
mise tasks          # List available tasks
```

Every npm script has a task with the same name, including `build:host`, `test:host`, `install:host`,
`uninstall:host`, `test:windows:wine`, `lint`, and `eval:act`. Tasks delegate to npm and forward
arguments; for example, `mise run eval:act --model <slug> --effort medium --repeat 3`.
`mise run lint:workflow` runs the pinned actionlint. Install development dependencies explicitly
with `mise run deps` or `npm ci`; verification does not reinstall them.

mise is optional for contributors, tests, and CI. A C compiler for race tests and Chrome remain
platform prerequisites. Docker for container checks and Wine for Windows compatibility checks are installed separately
when needed; mise does not provision them.
Keep version pins aligned with CI when upgrading tools.

## Continuous integration and downloads

GitHub Actions is configured to build and test all six native OS/architecture targets. Each passing
target produces a companion archive with its licenses and SHA-256 checksum, retained as a workflow
artifact for seven days. Build one locally with `go run ./native-host/cmd/build --check --package`;
output is written to `build/packages/`. No OpenAI credentials or live model requests are used in CI.

The first hosted runs remain pending until the initial push. Manual Chrome browser verification
is separate, and downloadable builds do not yet have release signing/notarization. See
[CI and artifact instructions](docs/CI.md) for the matrix, synthetic authentication checks, and downloads.

The extension remains plain HTML, CSS, and JavaScript with no browser-side build. Chrome code lives in `extension/`; one application controller owns readiness and prompt workflows while authentication, chat rendering, settings, page reading, and page action execution remain isolated supporting features. The companion keeps authentication and model requests separate under `native-host/`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) explains components, data flows, storage, and trust boundaries.
- [Act evaluations](docs/EVALUATIONS.md) explains when to run real-model tests, add simulated websites, and compare behavior.
- [Known limitations](docs/KNOWN_LIMITATIONS.md) records current platform and model constraints.
- [Roadmap](docs/TODO.md) tracks explicitly deferred work and investigations.
- [CI and artifacts](docs/CI.md) describes native verification and downloadable development builds.
- [Storage evaluation](docs/STORAGE_EVALUATION.md) archives the retired persistent-credential comparison and keyring integration.
- [Third-party notice](NOTICE.md) summarizes dependency licenses and sign-in asset attribution.

## Product direction

BrowseFriend explains the current page, shows inspectable shared context, and keeps page interaction behind explicit Act authorization. Consequential actions—submissions, purchases, account changes, downloads, or messages—must always require confirmation.
