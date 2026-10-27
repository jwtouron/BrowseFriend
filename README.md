# ChatGPT Sidecar

A minimal Chrome side-panel extension with a local chat interface. It has no API integration, authentication, storage, or background service yet.

## Product direction

The long-term goal is a browser companion that understands the page beside it. It should be able to answer questions about the current page, summarize or explain selected content, and eventually navigate and interact with sites on the user's behalf.

Build toward that goal in visible, permissioned stages:

1. Read explicitly requested page context and show what will be shared.
2. Answer questions about the page with clear source references.
3. Propose page actions before performing them.
4. Require confirmation for consequential actions such as submitting forms, making purchases, or sending messages.

The product name is still a working decision; `ChatGPT Sidecar` is only the current development label.

### Account scope

This is a personal, local-first utility—not a subscription service. It should not create its own user accounts, billing, or plans. The intended connection UI is a single **Continue with ChatGPT** action that opens OpenAI's hosted sign-in page. There, users authenticate using whichever method is attached to their ChatGPT account, including Google when available. The extension does not need a separate Google OAuth flow.

OpenAI currently documents ChatGPT-plan access for open-source and locally running projects. Its reference implementation uses a local runtime and loopback callback, so compatibility with a standalone Chrome extension must be verified before authentication is implemented. Do not substitute scraping, shared cookies, or private `chatgpt.com` endpoints. Anonymous use is only a possible future feature if OpenAI provides a supported path that does not require this project to operate accounts or billing.

## Try it in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this repository folder.
4. Open Chrome's side panel, choose **ChatGPT Sidecar**, and try the interface.

After changing a file, return to `chrome://extensions` and click the extension's reload button. Refreshing the side panel is sometimes also necessary.

## How the pieces fit

- `manifest.json` declares a Manifest V3 extension and points Chrome to the side-panel page.
- `sidepanel.html` contains semantic UI structure and a reusable message template.
- `styles.css` controls the responsive light/dark appearance.
- `sidepanel.js` handles local interactions and safely inserts messages with `textContent`.

The next plumbing step is to validate the official ChatGPT sign-in boundary. Never put a long-lived API secret in extension code: users can inspect every shipped file. Page access will also require carefully scoped host permissions and a content script; add those only with the corresponding feature.
