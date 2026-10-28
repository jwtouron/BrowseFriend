# BrowseFriend

BrowseFriend is a local-first Chrome side-panel companion. It provides a supported **Continue with ChatGPT** connection and a read-only Ask mode that shares inspectable semantic context from the active page.

## Authentication boundary

The extension never receives OAuth credentials. Its service worker talks to a Node.js native-messaging host that runs OpenAI's loopback sign-in flow and returns only display-safe account state. Tokens are encrypted with a random key protected by macOS Keychain or Linux Secret Service.

BrowseFriend does not create product accounts, subscriptions, or billing. It does not read ChatGPT cookies, conversations, or private endpoints. The official flow can use eligible ChatGPT plan usage but does not expose existing ChatGPT history.

Model requests use `store: false`; BrowseFriend keeps the current transcript in Chrome's memory-only session storage. It disappears when Chrome restarts or the extension reloads.

## Prerequisites

- Google Chrome 141 or newer on macOS or desktop Linux.
- Node.js 22.12 or newer.
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

Open BrowseFriend from Chrome's toolbar. The chat is usable immediately while the header indicator quietly checks the local companion, saved account, and available models. Yellow means connecting, green means ready, and red means an action or retry is required.

Signed-out users see **Continue with ChatGPT** inside the chat. OpenAI handles account and workspace selection in the browser, then returns to the local companion. A prompt submitted while setup is still running waits and sends automatically once ready. **Settings → Account** shows the selected identity, plan-access state, usage link, and logout action.

Ask a question to capture the current HTTP or HTTPS page. BrowseFriend sends a bounded semantic snapshot—not raw HTML—and Debug mode can show the inspectable context attachment beside the message. If the page changes during generation, the completed answer is marked as stale. **New chat** clears the memory-only conversation.

Send changes to Stop while a prompt is waiting or generating. Stop leaves connection setup running, restores the prompt as an editable draft, and preserves any partial answer as stopped. Connection and response failures share a Retry action; retrying a response captures fresh page context and replaces the failed attempt.

Appearance settings persist the System, Light, or Dark theme and one of seven accent colors; blue is the default. Settings can also use the first available model automatically or persist an explicit model choice. The selected model applies to the next response and does not clear the current chat.

With an empty composer, use Up or Ctrl+P to recall earlier prompts; continue with Up/Down or Ctrl+P/N. Typing starts a fresh draft. Use the × control or Ctrl+U to clear the composer.

If the panel reports that the companion is unavailable, rerun `npm run install:host`, reload the extension, and select **Retry**.

## Development commands

```sh
npm test              # Run authentication, bridge, UI, and security tests.
npm run lint          # Check JavaScript syntax.
npm run verify        # Run all local syntax, test, and manifest checks.
npm run setup:devkit  # Install and build the pinned OpenAI local SDK.
python3 -m json.tool manifest.json
```

`setup:devkit` preserves the upstream dependency lock while replacing only the
advisory-affected `undici` package with the compatible patched version recorded
in `scripts/setup-devkit.mjs`.

The extension remains plain HTML, CSS, and JavaScript with no browser-side build. Chrome code lives in `extension/`; one application controller owns readiness and prompt workflows while authentication, chat rendering, settings, and page reading remain isolated supporting features. The companion keeps authentication and model requests separate under `native-host/`. OpenAI's pinned DevKit lives in `vendor/sign-in-with-chatgpt-devkit/`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) explains components, data flows, storage, and trust boundaries.
- [Known limitations](docs/KNOWN_LIMITATIONS.md) records current platform and model constraints.
- [Roadmap](docs/TODO.md) tracks explicitly deferred work and investigations.
- [Third-party notice](NOTICE.md) summarizes DevKit licensing and redistribution requirements.

## Product direction

BrowseFriend should eventually explain the current page, show exactly what context will be shared, and propose browser actions before performing them. Consequential actions—submissions, purchases, account changes, or messages—must always require explicit confirmation.
