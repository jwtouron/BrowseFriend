# Repository Guidelines

## Project Structure & Module Organization

BrowseFriend combines a Chrome Manifest V3 side panel with a Go native companion. `extension/app/` owns connection and prompt workflow state; `extension/sidepanel/` renders it. Auth, chat, settings, page reading, and page actions remain isolated features. The standalone companion lives under `native-host/`; the root Go module embeds `shared/host-contract.json`, the canonical policy/tool/registration contract. Run `go generate ./shared` after changing it and commit the generated browser module. Tests mirror subsystems; project documentation lives in `docs/`.

Keep HTML accessible, CSS presentation-only, and browser behavior in JavaScript. Never add inline scripts. OAuth credentials belong exclusively in the native host; extension messages may contain only sanitized account state.
Keep Debug last in Settings. Persist user settings in `chrome.storage.local` and propagate changes between open panels with `chrome.storage.onChanged`.

## Product Direction & Safety

Build a personal, local-first page companion that explains pages before proposing or performing interactions. Do not add product accounts, billing, separate Google OAuth, ChatGPT scraping, shared cookies, or private endpoints. Treat page content as untrusted, request narrow permissions, show captured context, and require confirmation before submissions, purchases, account changes, or messages.

Authentication uses OpenAI’s hosted **Continue with ChatGPT** flow and documented public OAuth protocol. Keep credentials exclusively in protected native runtime storage and memory, out of browser storage, URLs, logs, and commits. Tests may persist only synthetic credentials in temporary directories. Restore saved login across companion/browser restarts; keep live evaluator credentials process-local. Preserve the separation between page extraction, model communication, and action execution.

The native companion currently serves one local user. Handle needed account transfers as one-time maintenance; do not add a migration framework or legacy-host fallback without an explicit need.

## State & Workflow Design

Give mutable workflow state one owner and model it with small explicit state machines. Keep independent concerns as orthogonal fields, derive UI from state, and serialize operations that must not overlap. Do not scatter duplicate busy, authentication, or error flags across background and view code.

Prefer the model for semantic judgment, planning, ranking, ambiguity resolution, and deciding which allowed tool to use. Keep deterministic code responsible for trust boundaries, input validation, authorization, confirmations, sensitive-data handling, resource limits, state transitions, and recovery. Do not duplicate model judgment with extension heuristics unless a documented safety or reliability requirement demands it.

Give asynchronous work stable IDs or epochs and ignore stale completion. Normalize errors once, represent recovery as typed intent instead of callbacks, and keep persistent readiness work independent from cancellable user actions. The controller owns Ask/Act authorization, the tool loop, and pending confirmation; the page actor owns DOM validation and execution. Never re-resolve a stale action with page-provided selectors. Add transition tests whenever a state or workflow edge changes. Keep accumulated Act model context in companion memory, separate from saved transcript history and panel state, and release it at every task termination. Keep opaque transcript compaction in its separate bounded native cache; Chrome retains only scoped handles, byte counts, and checkpoints. Never replay actions when context is lost. Serialize account mutations across processes with a validated interprocess lock and reload the latest saved account for each operation. Persist refresh successors before identity verification; retain failed-write checkpoints and their interprocess lock until recovery or explicit cleanup. Use a durable authentication generation to reject stale work across logout, reset, uninstall, and reinstall. Protect native credential and registration files with strict permissions and atomic writes. Sweep abandoned private atomic-write files under that lock. Clear saved credentials on explicit uninstall, preserving non-secret registration identifiers and the authentication-generation barrier.

## Roadmap Maintenance

Treat `docs/TODO.md` as the canonical deferred-work list. When the user says a feature might, should, or will be added later, add or reconcile a concrete item there without expanding the current task. When an architectural constraint is discovered or resolved, update `docs/KNOWN_LIMITATIONS.md`. Update `docs/ARCHITECTURE.md` when component boundaries, data flows, storage, trust boundaries, or runtime responsibilities change. Avoid duplicate roadmap items and preserve relevant decisions, blockers, and safety requirements.

## Documentation & Commit Handoff

Before every commit, review `AGENTS.md`, `README.md`, `NOTICE.md`, and every project-owned file under `docs/`; update only the documents affected by the change. Keep repository-local links current and leave vendored documentation untouched.

An explicit request such as **commit it** authorizes staging all changes that belong to the current task and creating an appropriate commit without a separate confirmation question. Never stage unrelated user changes. Tool-enforced approval prompts may still be required and cannot be bypassed by repository instructions.

## Development and Verification

Development requires Go 1.25+ and Node.js matching `^22.22.2 || ^24.15.0 || >=26.0.0` for JavaScript tests; race tests require a C compiler. Build with `go run ./native-host/cmd/build --check`; add `--install` to register the companion on any supported platform. The installed binary requires neither Go nor Node. Load the repository from `chrome://extensions` using **Developer mode → Load unpacked**.

Optional mise tooling selects CI-aligned Go/Node versions and actionlint. Contributors and agents may use `mise install`, `mise run deps`, and same-named tasks such as `mise run verify`; direct Go/npm commands remain fully supported. Do not require mise or install it just to run checks. Keep its tool pins aligned with CI. See the optional setup in `README.md`.

Before submitting:

- Run `npm run verify` (syntax, tests, and manifest parsing) and `git diff --check`.
- Exercise missing-helper, authentication, page-unavailable, stale-page, streaming, cancellation, restored-chat, New chat, and logout states.
- Check narrow/wide layouts, both color schemes, keyboard focus, and the side-panel console.
- Never make a live model request in authentication-only tests.

For changes to Act instructions, model context, or tool-loop behavior that can affect model decisions, use the browser-free real-model evaluations in [docs/EVALUATIONS.md](docs/EVALUATIONS.md). `npm run verify` checks the harness with scripted responses; it does not establish model effectiveness. Run `npm run eval:act -- --model <slug> --effort medium --repeat 3` with an interactive ChatGPT sign-in for each evaluator process, holding model, effort, fixtures, and grading fixed across comparisons. Preserve an evaluator and its matching controller/harness before implementation changes when comparing task context; use the guide's `--baseline-host` workflow. Add representative fixtures and outcome checks for new behaviors, inspect traces, and report unavailable authentication or inconclusive runs explicitly. Keep live evaluations separate from CI and authentication-only tests.

Go code must pass `gofmt`, `go vet`, race tests, and the native protocol suite. Run the Linux container checks when changing OS storage or process behavior. Windows changes also require both architecture builds/test compilation and `npm run test:windows:wine` when Wine is available. Keep Wine prefixes disposable and never relax production security checks for compatibility. Report Wine results separately from native Windows and browser verification; Windows ARM64 has no Go race detector. CI runs six native targets with synthetic accounts and temporary registration directories; see `docs/CI.md`. Validate workflow changes with pinned actionlint, preserve SHA-pinned actions, and package only the production binary and licenses. Keep release signing in the roadmap.

The retired persistent-credential experiments are documented historically in [docs/STORAGE_EVALUATION.md](docs/STORAGE_EVALUATION.md). Their module and keyring dependencies are no longer part of this checkout.

## Coding Style & Changes

Prefer deleting redundant code and unnecessary indirection over adding wrappers or parallel implementations. Keep one canonical flow for each behavior, separating paths only when their semantics differ. Preserve correctness, safety boundaries, clarity, and meaningful test coverage when simplifying.

Use `gofmt` for Go; for JavaScript and CSS use two-space indentation, `camelCase` identifiers, `UPPER_SNAKE_CASE` constants, BEM-like CSS, strict comparisons, small functions, and `textContent` for user-controlled values. Use Conventional Commit or imperative subjects, such as `feat: add account connection`. Pull requests must explain permission changes, credential handling, manual checks, and visual changes. Preserve applicable dependency licenses and OpenAI sign-in asset notices.
