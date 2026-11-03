# BrowseFriend

BrowseFriend is a local-first Chrome side-panel companion. It provides a supported **Continue with ChatGPT** connection, a read-only Ask mode, and an explicit Act mode for validated page interaction.

## Authentication boundary

The extension never receives OAuth credentials. Its service worker talks to a native-messaging host
written in Go that runs OpenAI's loopback sign-in flow and returns only
display-safe account state. Tokens are encrypted with a random key protected by macOS Keychain,
Linux Secret Service, or Windows Credential Manager.

BrowseFriend does not create product accounts, subscriptions, or billing. It does not read ChatGPT cookies, conversations, memory, or private endpoints. The official flow can use eligible ChatGPT plan usage but does not grant access to ChatGPT history or memory.

Model requests use `store: false`; BrowseFriend supplies only its fixed instructions, local transcript,
current page context, and current prompt. During one Act task, Go also retains earlier page
observations, model outputs, and tool results in memory, discarding them when the task ends. When reusable transcript context exceeds 256 KiB,
BrowseFriend uses OpenAI's stateless compaction endpoint and keeps the latest eight exchanges
verbatim. Past page-action records are included only for those eight exchanges. The transcript and
opaque compacted context use one global Chrome session shared by open panels and disappear when
Chrome restarts or the extension reloads.

## Prerequisites

- Google Chrome 141 or newer on macOS, desktop Linux, or Windows 11 (x64/ARM64).
- Node.js matching `^22.22.2 || ^24.15.0 || >=26.0.0` for JavaScript tests only.
- Go 1.25+ to build/test the companion; a C compiler for race tests.
- Linux only: a running D-Bus session and Secret Service provider (for example GNOME Keyring).
- A ChatGPT account eligible for Sign in with ChatGPT plan usage.

BrowseFriend is a personal, local-first project. Its original code is [MIT licensed](LICENSE).
Dependencies and OpenAI sign-in artwork retain their separate terms; see [NOTICE.md](NOTICE.md).

## Install for development

```sh
go run ./native-host/cmd/build --check --install
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository. The checked-in manifest key gives development builds the stable ID expected by the native host. Reload the extension after code changes.

The installer copies the standalone binary into the application-data directory and registers it with Chrome. Moving the repository does not affect the installed copy. Unregister it with `go run ./native-host/cmd/build --check --uninstall`; account data is preserved.

On Windows, installation uses the current user's registry and needs no administrator access. Close
BrowseFriend before replacing or removing a running companion. A downloaded Windows executable can
register itself with `./browsefriend-native-host.exe install` after extracting the matching x64 or
ARM64 archive.

Windows x64 and ARM64 binaries are cross-compiled. Automated x64 compatibility tests run under Wine
on macOS. Native Windows testing, ARM64 runtime testing, and manual Chrome browser verification
remain pending; see the [verification record](docs/NATIVE_HOST.md#verification-record).

## Use

See [Native companion](docs/NATIVE_HOST.md) for standalone commands, storage locations, tests, and platform verification.

Open BrowseFriend from Chrome's toolbar. The chat is usable immediately while the header indicator quietly checks the local companion, saved account, and available models. Yellow means connecting, green means ready, and red means an action or retry is required.

Signed-out users see **Continue with ChatGPT** inside the chat. OpenAI handles account and workspace selection in the browser, then returns to the local companion. A prompt submitted while setup is still running waits and sends automatically once ready. **Settings → Account** shows the selected identity, plan-access state, usage link, and logout action.

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

Send changes to Stop while a prompt is waiting or generating. Stop leaves connection setup running, restores the prompt as an editable draft, and preserves any partial answer as stopped. Connection and response failures share a Retry action; retrying a response captures fresh page context and replaces the failed attempt.

Appearance settings persist the System, Light, or Dark theme and one of seven accent colors; blue is
the default. Settings can also use the first available model automatically or persist an explicit
model choice. Reasoning effort defaults to the selected model's advertised default; its dropdown
then lists that model's supported explicit efforts from highest to lowest. Model and effort changes
apply to the next response and do not clear the current chat.

The chat footer shows the resolved model and effort expected for the next prompt. The **Automatic**
model option names the first listed model it currently resolves to. Select the footer summary to
open Model settings; use the warning icon beside it to review the page-context sharing notice.

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

## Continuous integration and downloads

GitHub Actions is configured to build and test all six native OS/architecture targets. Each passing
target produces a companion archive with its licenses and SHA-256 checksum, retained as a workflow
artifact for seven days. Build one locally with `go run ./native-host/cmd/build --check --package`;
output is written to `build/packages/`. No OpenAI credentials or live model requests are used in CI.

The first hosted runs remain pending until the initial push. Manual Chrome browser verification
is separate, and downloadable builds do not yet have release signing/notarization. See
[CI and artifact instructions](docs/CI.md) for the matrix, isolated credential-store checks, and downloads.

The extension remains plain HTML, CSS, and JavaScript with no browser-side build. Chrome code lives in `extension/`; one application controller owns readiness and prompt workflows while authentication, chat rendering, settings, page reading, and page action execution remain isolated supporting features. The companion keeps authentication and model requests separate under `native-host/`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) explains components, data flows, storage, and trust boundaries.
- [Act evaluations](docs/EVALUATIONS.md) explains when to run real-model tests, add simulated websites, and compare behavior.
- [Known limitations](docs/KNOWN_LIMITATIONS.md) records current platform and model constraints.
- [Roadmap](docs/TODO.md) tracks explicitly deferred work and investigations.
- [CI and artifacts](docs/CI.md) describes native verification and downloadable development builds.
- [Storage evaluation](docs/STORAGE_EVALUATION.md) records the original library comparison and subsequent keyring integration.
- [Third-party notice](NOTICE.md) summarizes dependency licenses and sign-in asset attribution.

## Product direction

BrowseFriend explains the current page, shows inspectable shared context, and keeps page interaction behind explicit Act authorization. Consequential actions—submissions, purchases, account changes, downloads, or messages—must always require confirmation.
