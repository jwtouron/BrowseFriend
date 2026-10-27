# Repository Guidelines

## Project Structure & Module Organization

BrowseFriend is a Chrome Manifest V3 side-panel extension plus a local Node.js authentication companion. `extension/sidepanel/` owns the panel, `extension/background/` owns the toolbar entrypoint, and `extension/auth/` isolates browser-side authentication. Native authentication lives in `native-host/auth/`, native-message framing in `native-host/messaging/`, and stable host entrypoints remain at the `native-host/` root. Tests mirror these subsystems under `tests/`; `vendor/sign-in-with-chatgpt-devkit/` pins OpenAI's official SDK submodule.

Keep HTML accessible, CSS presentation-only, and browser behavior in JavaScript. Never add inline scripts. OAuth credentials belong exclusively in the native host; extension messages may contain only sanitized account state.

## Product Direction & Safety

Build a personal, local-first page companion that explains pages before proposing or performing interactions. Do not add product accounts, billing, separate Google OAuth, ChatGPT scraping, shared cookies, or private endpoints. Treat page content as untrusted, request narrow permissions, show captured context, and require confirmation before submissions, purchases, account changes, or messages.

Authentication must use OpenAI's hosted **Continue with ChatGPT** flow through the pinned local DevKit. Keep credentials encrypted with an OS-backed key, out of browser storage, URLs, logs, tests, and commits. Preserve the separation between page extraction, model communication, and action execution.

## Development and Verification

Requires Node.js 22.12+. Initialize and build the SDK with `git submodule update --init` and `npm run setup:devkit`; register the companion with `npm run install:host`. Load the repository from `chrome://extensions` using **Developer mode → Load unpacked**.

Before submitting:

- Run `npm run verify` (syntax, tests, and manifest parsing) and `git diff --check`.
- Exercise missing-helper, sign-in, cancellation, plan-disabled, restored-session, and logout states.
- Check narrow/wide layouts, both color schemes, keyboard focus, and the side-panel console.
- Never make a live model request in authentication-only tests.

## Coding Style & Changes

Use two-space indentation, `camelCase` identifiers, `UPPER_SNAKE_CASE` constants, BEM-like CSS, strict comparisons, small functions, and `textContent` for user-controlled values. Use Conventional Commit or imperative subjects, such as `feat: add account connection`. Pull requests must explain permission changes, credential handling, manual checks, and visual changes. Preserve OpenAI DevKit licensing and notices.
