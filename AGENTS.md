# Repository Guidelines

## Project Structure & Module Organization

This dependency-free Chrome Manifest V3 extension maps `manifest.json` to `sidepanel.html`. Markup lives in `sidepanel.html`, presentation in `styles.css`, and interactions in `sidepanel.js`. Keep assets in `assets/` and tests in `tests/`.

Keep this separation intact: HTML defines accessible structure, CSS owns appearance, and JavaScript owns behavior. Do not add inline scripts because extension Content Security Policy restricts them.

## Product Direction & Safety

The extension should grow into a page-aware browser companion that first explains pages, then proposes and performs interactions. It is a personal, local-first utility. Do not add product accounts, subscriptions, billing, or separate Google OAuth. Authentication should use one OpenAI-hosted **Continue with ChatGPT** flow. Verify support for standalone Chrome extensions first; do not scrape ChatGPT, reuse website cookies, or call private endpoints.

Treat page content as untrusted input. Request the narrowest permissions, show captured context, and distinguish suggestions from actions. Require confirmation before submissions, purchases, account changes, or messages. Keep extraction, model communication, and action execution separate.

## Development and Verification

There is no build step or package dependency. Load the repository directly from `chrome://extensions` using **Developer mode → Load unpacked**. After edits, reload the extension from that page and reopen or refresh the side panel.

Before submitting changes:

- Validate `manifest.json` with `python3 -m json.tool manifest.json`.
- Check the side panel at narrow and wide widths.
- Exercise sending, multiline input (`Shift+Enter`), suggestions, clearing, closing, and both color schemes.
- Inspect the side panel console for errors.

If tooling is introduced, add predictable `npm` scripts such as `npm test` and `npm run lint`, and document them here and in `README.md`.

## Coding Style & Naming Conventions

Use two-space indentation in HTML, CSS, JSON, and JavaScript. Use `camelCase` for JavaScript identifiers, `UPPER_SNAKE_CASE` for true constants, and BEM-like CSS classes such as `.message__content` and `.message--user`. Prefer `const`, strict comparisons, small functions, semantic HTML, and native browser APIs. Use `textContent`, not `innerHTML`, for user-controlled content. Preserve keyboard access, focus states, labels, and reduced assumptions about panel width.

## Testing and Changes

No automated tests or Git history exist yet. Add regression coverage for nontrivial logic. Use imperative or Conventional Commit subjects, such as `feat: add page summary`. Pull requests should explain behavior, permissions, manual checks, and visual updates. Keep API integration out of UI-only changes; never commit credentials.
