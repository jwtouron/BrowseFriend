# Repository Guidelines

## Project Structure & Module Organization

BrowseFriend combines a Chrome Manifest V3 side panel with a local Node.js companion. `extension/app/` owns connection and prompt workflow state; `extension/sidepanel/` renders it; `extension/auth/`, `extension/chat/`, `extension/settings/`, `extension/page/read/`, and `extension/page/act/` isolate supporting features. Shared page-tool schemas live in `shared/`; Native authentication and model requests live under `native-host/`; tests mirror subsystems under `tests/`, project documentation lives in `docs/`, and `vendor/sign-in-with-chatgpt-devkit/` pins OpenAI's SDK. Keep downstream SDK changes reproducible as reviewed patches under `patches/`, never as a dirty submodule.

Keep HTML accessible, CSS presentation-only, and browser behavior in JavaScript. Never add inline scripts. OAuth credentials belong exclusively in the native host; extension messages may contain only sanitized account state.
Keep Debug last in Settings. Persist user settings in `chrome.storage.local` and propagate changes between open panels with `chrome.storage.onChanged`.

## Product Direction & Safety

Build a personal, local-first page companion that explains pages before proposing or performing interactions. Do not add product accounts, billing, separate Google OAuth, ChatGPT scraping, shared cookies, or private endpoints. Treat page content as untrusted, request narrow permissions, show captured context, and require confirmation before submissions, purchases, account changes, or messages.

Authentication must use OpenAI's hosted **Continue with ChatGPT** flow through the pinned local DevKit. Keep credentials encrypted with an OS-backed key, out of browser storage, URLs, logs, tests, and commits. Preserve the separation between page extraction, model communication, and action execution.

## State & Workflow Design

Give mutable workflow state one owner and model it with small explicit state machines. Keep independent concerns as orthogonal fields, derive UI from state, and serialize operations that must not overlap. Do not scatter duplicate busy, authentication, or error flags across background and view code.

Prefer the model for semantic judgment, planning, ranking, ambiguity resolution, and deciding which allowed tool to use. Keep deterministic code responsible for trust boundaries, input validation, authorization, confirmations, sensitive-data handling, resource limits, state transitions, and recovery. Do not duplicate model judgment with extension heuristics unless a documented safety or reliability requirement demands it.

Give asynchronous work stable IDs or epochs and ignore stale completion. Normalize errors once, represent recovery as typed intent instead of callbacks, and keep persistent readiness work independent from cancellable user actions. The controller owns Ask/Act authorization, the tool loop, and pending confirmation; the page actor owns DOM validation and execution. Never re-resolve a stale action with page-provided selectors. Add transition tests whenever a state or workflow edge changes.

## Roadmap Maintenance

Treat `docs/TODO.md` as the canonical deferred-work list. When the user says a feature might, should, or will be added later, add or reconcile a concrete item there without expanding the current task. When an architectural constraint is discovered or resolved, update `docs/KNOWN_LIMITATIONS.md`. Update `docs/ARCHITECTURE.md` when component boundaries, data flows, storage, trust boundaries, or runtime responsibilities change. Avoid duplicate roadmap items and preserve relevant decisions, blockers, and safety requirements.

## Documentation & Commit Handoff

Before every commit, review `AGENTS.md`, `README.md`, `NOTICE.md`, and every project-owned file under `docs/`; update only the documents affected by the change. Keep repository-local links current and leave vendored documentation untouched.

An explicit request such as **commit it** authorizes staging all changes that belong to the current task and creating an appropriate commit without a separate confirmation question. Never stage unrelated user changes. Tool-enforced approval prompts may still be required and cannot be bypassed by repository instructions.

## Development and Verification

Requires Node.js 22.12+. Initialize and build the SDK with `git submodule update --init` and `npm run setup:devkit`; register the companion with `npm run install:host`. Load the repository from `chrome://extensions` using **Developer mode → Load unpacked**.

Before submitting:

- Run `npm run verify` (syntax, tests, and manifest parsing) and `git diff --check`.
- Exercise missing-helper, authentication, page-unavailable, stale-page, streaming, cancellation, restored-chat, New chat, and logout states.
- Check narrow/wide layouts, both color schemes, keyboard focus, and the side-panel console.
- Never make a live model request in authentication-only tests.

## Coding Style & Changes

Use two-space indentation, `camelCase` identifiers, `UPPER_SNAKE_CASE` constants, BEM-like CSS, strict comparisons, small functions, and `textContent` for user-controlled values. Use Conventional Commit or imperative subjects, such as `feat: add account connection`. Pull requests must explain permission changes, credential handling, manual checks, and visual changes. Preserve OpenAI DevKit licensing and notices.
