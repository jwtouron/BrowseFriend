# BrowseFriend

BrowseFriend is a local-first Chrome side-panel companion. It provides a supported **Continue with ChatGPT** connection, a read-only Ask mode, and an explicit Act mode for validated page interaction.

## Authentication boundary

The extension never receives OAuth credentials. Its service worker talks to a native-messaging host
(Node by default, Go as an opt-in prototype) that runs OpenAI's loopback sign-in flow and returns only
display-safe account state. Tokens are encrypted with a random key protected by macOS Keychain or
Linux Secret Service.

BrowseFriend does not create product accounts, subscriptions, or billing. It does not read ChatGPT cookies, conversations, memory, or private endpoints. The official flow can use eligible ChatGPT plan usage but does not grant access to ChatGPT history or memory.

Model requests use `store: false`; BrowseFriend supplies only its fixed instructions, local transcript,
current page context, and current prompt. When reusable transcript context exceeds 256 KiB,
BrowseFriend uses OpenAI's stateless compaction endpoint and keeps the latest eight exchanges
verbatim. Past page-action records are included only for those eight exchanges. The transcript and
opaque compacted context use one global Chrome session shared by open panels and disappear when
Chrome restarts or the extension reloads.

## Prerequisites

- Google Chrome 141 or newer on macOS or desktop Linux.
- Node.js 22.12 or newer.
- Go 1.25+ to build/test the prototype; a C compiler for race tests.
- Linux only: Secret Service plus `secret-tool` (usually the `libsecret-tools` package).
- A ChatGPT account eligible for Sign in with ChatGPT plan usage.

The official DevKit is licensed for noncommercial use. BrowseFriend is currently a personal, noncommercial project; review [NOTICE.md](NOTICE.md) before redistributing it.

## Install for development

```sh
git submodule update --init
npm run setup:devkit
npm run install:host
```

If Homebrew installed versioned Node on macOS, first run:

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository. The checked-in manifest key gives development builds the stable ID expected by the native host. Reload the extension after code changes.

Moving the repository invalidates the installed launcher path; rerun `npm run install:host`. To unregister the companion without deleting saved account data, run `npm run uninstall:host`.

## Use

An opt-in **Go companion prototype** can replace the Node process while keeping the same extension.
It uses a fresh, separately encrypted sign-in. Build with `npm run build:host:go`, then opt in with
`npm run install:host -- --runtime=go` and reload the extension. Restore Node with
`npm run install:host -- --runtime=node`. Go 1.25+ is needed to build; the resulting binary needs no
Go, Node, or DevKit runtime. See [Go prototype evaluation](docs/GO_PROTOTYPE.md) for verification,
storage details, limitations, and the browser trial.

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

## Development commands

```sh
npm test              # Run authentication, bridge, UI, and security tests.
npm run lint          # Check JavaScript syntax.
npm run verify        # Run all local syntax, test, and manifest checks.
npm run setup:devkit  # Install and build the pinned OpenAI local SDK.
npm run build:host:go # Build the standalone Go prototype.
npm run test:host:go  # Go race/vet checks and Node/Go contract parity.
python3 -m json.tool manifest.json
```

`setup:devkit` preserves the upstream dependency lock while replacing only the advisory-affected
`undici` package with the compatible patched version recorded in `scripts/setup-devkit.mjs`. It also
applies the reviewed `patches/devkit-function-tools.patch` and `patches/devkit-compaction.patch`
while building typed tool-call, reasoning-effort, and stateless transcript-compaction support, then
restores the pinned submodule sources.

The extension remains plain HTML, CSS, and JavaScript with no browser-side build. Chrome code lives in `extension/`; one application controller owns readiness and prompt workflows while authentication, chat rendering, settings, page reading, and page action execution remain isolated supporting features. The companion keeps authentication and model requests separate under `native-host/`. OpenAI's pinned DevKit lives in `vendor/sign-in-with-chatgpt-devkit/`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) explains components, data flows, storage, and trust boundaries.
- [Known limitations](docs/KNOWN_LIMITATIONS.md) records current platform and model constraints.
- [Roadmap](docs/TODO.md) tracks explicitly deferred work and investigations.
- [Third-party notice](NOTICE.md) summarizes DevKit licensing and redistribution requirements.

## Product direction

BrowseFriend explains the current page, shows inspectable shared context, and keeps page interaction behind explicit Act authorization. Consequential actions—submissions, purchases, account changes, downloads, or messages—must always require confirmation.
