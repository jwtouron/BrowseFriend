# Act evaluations

`npm run eval:act -- --model <account-model-slug> --effort medium --repeat 1`
always uses the real model and a real rubric grader. Complete ChatGPT sign-in in the browser
when prompted at startup. Each evaluator keeps one authenticated Go process for the run; it cannot
reuse a login from the extension or an earlier run. No API key, browser automation, DevTools MCP,
browser registration, or model-facing local web server is needed. OAuth uses the normal temporary
loopback listener. Credentials and refresh recovery stay in Go memory. The evaluation-only
`eval.configure` operation changes baseline/candidate/grading mode only while idle and clears task
context; it is absent from the production host. Normal compaction is available; logout is disabled.

Install development dependencies with `npm ci`. Node must satisfy
`^22.22.2 || ^24.15.0 || >=26.0.0`; Go 1.25+ is required. The command builds its separate
evaluation helper locally. That helper is not registered or packaged as the production host.

If you use mise, the equivalent command is
`mise run eval:act --model <account-model-slug> --effort medium --repeat 1`, after optional tool
setup and `mise run deps`. Arguments go directly after the task name; mise adds npm's separator.
The existing npm command works without mise. See [optional setup](../README.md#optional-mise-setup).

## When to use and extend the harness

Use real-model evaluations when changing Act instructions, retained model context, or tool-loop
behavior that affects the model's decisions. Run ordinary verification first, then compare fixed
model/effort settings over repeated trials. The default comparison isolates instruction changes on
the current implementation; `--baseline-host` compares implementations with identical current
instructions. Preserve that executable and its matching controller/harness before editing implementation code
when a change alters the native protocol. If interactive authentication or
requested model is unavailable, report live evaluation as blocked or inconclusive, never as passed.

To cover another behavior:

1. Add a scenario to `tests/act-evaluation/site.mjs`, with trusted local HTML, navigation routes,
   and any relevant DOM mutations. Model choices must determine the path through those pages.
2. Update `tests/act-evaluation/harness.mjs` with the task prompt, ground truth, and observable
   success checks. Current prompts/checks assume repository files; adapt those assumptions for
   other tasks rather than counting generic navigation or final text as success.
3. Update the grader rubric in `native-host/cmd/eval-act/main.go` if the new task needs different
   criteria. Judge both variants against the same criteria and keep the grader blinded.
4. Add scripted regression tests in `tests/act-evaluation.test.mjs` for the fixture and checks,
   then run the real evaluation. Scripted tests establish harness correctness, not model behavior.

Keep fixtures, checks, budgets, and rubric fixed during a comparison. If a fixture is found to be
incorrect, retain the old report with an invalidation explanation and rerun both variants after the
correction. Inspect traces and record failures; do not weaken criteria to obtain passing results.
Preserved executables must support the controller's native protocol; incompatible interfaces make
that comparison inconclusive. Local binaries/reports are ignored build artifacts and are not
available automatically in a fresh checkout. Record durable conclusions and limitations here.

## What runs

Trusted HTML fixtures load into jsdom, using the actual page reader, action content
script, background reader/actor, and application controller. A small simulated Chrome
API routes messages, script installation, and navigation between fixture documents.
Opaque refs and DOM mutation revisions come from production code. Layout/scrolling
are simulated; this does not verify Chrome rendering, side-panel UI, or native messaging installation.
Fixture resources and destinations are resolved locally, never fetched from real websites.

Each case starts with fresh in-memory chat and settings. Scenarios cover an indexing
blocker, working file browsing despite unavailable search, indexing completing through
a DOM change without navigation, and a large transcript requiring compaction before Act. The last
scenario seeds ten synthetic exchanges and requires both source inspection and recalling the older
project codeword; ordinary CI checks only that the fixture and protocol behave correctly.
The model chooses its own actions; paths and pages are
not a prerecorded sequence.

The baseline is the original Act instruction text; the candidate is the current shared
contract. Model and effort remain fixed across both. The runner requires an explicit model,
checks catalog choices, and never substitutes a different model or effort. One repetition
runs eight tasks and eight grader requests; `--repeat N` alternates variant order between repetitions.
Each task allows eight tool calls and five minutes. Exceeding these bounds is failure,
not successful blocker recognition. There are no automatic task retries. Add `--scenario compaction`
to focus on the large-transcript fixture; the report records the selected scenarios. A preserved
baseline that lacks compaction may continue through raw-history fallback, but fails the unchanged
compaction-availability check and records `compactionUnavailable`. A candidate without a real
checkpoint remains inconclusive; a correct answer through fallback cannot pass this fixture.

## Compare task context separately

Before modifying the implementation, add the comparison fixture to both sides, then preserve the
evaluator and its matching browser controller/harness under ignored build output. The nested
`go.mod` keeps copied shared Go files out of ordinary verification:

```sh
mkdir -p build/act-context-baseline/source
cp -R extension shared tests package.json go.mod go.sum build/act-context-baseline/source/
go build -o build/act-context-baseline/eval-act ./native-host/cmd/eval-act
```

After implementing context retention, run:

```sh
npm run eval:act -- --model <slug> --effort medium --repeat 3 --baseline-host build/act-context-baseline/eval-act \
  --baseline-harness build/act-context-baseline/source/tests/act-evaluation/harness.mjs
```

This uses identical current instructions for both executables, isolating task-context behavior from
instruction changes. Without `--baseline-host`, the original instruction comparison remains available.
Reports identify comparison type, executable hashes, and harness/controller hashes. Site fixtures
must match. `--baseline-harness` is required with `--baseline-host` so protocol changes do not
accidentally run the candidate controller against an older helper. Keep the preserved binary when reproducing
results; it is a local evaluation control, not a production compatibility mode. Graders see observable
page/action traces and final answers, never the native buffer or opaque reasoning.

## Results

Ignored `build/act-evaluation/<timestamp>/` contains JSON evidence and a readable report:
instruction hashes, order, synthetic page/action traces, answers, checks, and rubric grades.
Account identity and OAuth credentials are not recorded. A blinded, tool-free judge checks
accuracy, unsupported claims, and unsuccessful repetition against observed evidence and
ground truth. It receives neither the variant label nor its instruction text. Model grades
are fallible; inspect the supporting trace and rationale when a result is surprising.

Candidate runs must pass both deterministic checks and the rubric. Baseline failures are
reported separately. Exit 0 means candidate success, 1 means behavioral failure, and 2
means interrupted/inconclusive execution. Authentication, usage, or transport failures
stop the remaining run. One paired trial is smoke evidence rather than a consistency claim.
Cancellation closes retained helpers and waits for Go cleanup. Authentication waits up to 120 seconds
per process by default; use `--auth-timeout <seconds>` (1–600) to change that bound. Each retained
helper authenticates separately and loses credentials on exit.

## Deterministic checks

`npm run verify` exercises the simulation, refs, mutations, controller flow, cancellation,
budgets, and grading validation with scripted model responses. These tests run in CI without
model calls or real credentials. They validate the harness, not instruction effectiveness.

## Initial verification record

On 2026-11-01 (local date), deterministic verification passed 118 JavaScript tests,
Go race tests/vet, and pinned actionlint. The evaluation helper's tests also cross-compiled
for Windows x64 and ARM64; this is not native Windows execution.

The corrected one-pair live comparison used `gpt-5.6-sol`, medium effort. Baseline passed
one of three scenarios; candidate passed none. Both variants repeatedly revisited the
same source file in the solvable scenarios and exhausted the action budget. The candidate
explained the indexing blocker accurately but unnecessarily retried its failed search.
This does not demonstrate that the revised instructions improve behavior. No checks or
rubric thresholds were relaxed to obtain a passing result.

Local evidence is in `build/act-evaluation/2026-11-02T02-57-30-544Z/`.
The earlier run is retained with an invalidation note because its recoverable search
page mistakenly claimed file browsing was unavailable too. The corrected fixture now
advertises the available alternative route and has a regression test.

## Task-context verification record

On 2026-11-01 (local date), three paired repetitions used `gpt-5.6-sol`, medium effort,
identical current instructions, unchanged fixtures, and the existing eight-action evaluation budget.
The pre-change executable passed **0/9** tasks; context retention passed **9/9**. Both instruction
hashes match in the report, which also records the two executable hashes.

| Scenario | Previous context | Retained context | Retained-context tool requests |
| --- | --- | --- | --- |
| Indexing blocks search and browsing | 0/3 | 3/3 | 1 per task |
| Search blocked, file browsing works | 0/3 | 3/3 | 5 per task |
| Indexing completes through a DOM mutation | 0/3 | 3/3 | 4 per task |

The old version explained indexing blockers accurately but retried unsuccessful routes; the solvable
cases repeatedly reopened one source file until the budget expired. Retained-context runs inspected
both source files and reported the two supported findings. These results support context retention
on these fixtures; they do not isolate encrypted reasoning from observation retention, establish
reliability on arbitrary sites, or verify Chrome rendering.

Evidence: `build/act-evaluation/2026-11-02T03-20-31-921Z/`; preserved control:
`build/act-context-baseline/eval-act`. Both are ignored local artifacts. No opaque native reasoning
or real account identity is included in the evaluation report.

Deterministic verification passed 127 JavaScript tests, macOS ARM64 Go race tests/vet, and the
native protocol suite. Linux ARM64 Docker race tests, isolated Secret Service checks, and companion
installation/removal passed. The native buffer's chronology, opaque-item replay, bounds, lost/mismatched
continuations, cancellation races, and terminal cleanup have regression coverage.
Windows x64/ARM64 companion builds and test compilation passed. Windows x64 Go tests, all eleven
JavaScript host/configuration checks, and installation/removal passed under Wine 11.20 Staging in a
disposable prefix. Wine has no race coverage here and does not verify native Windows security,
Windows ARM64 execution, or Chrome behavior. Manual browser checks were not run.

## Native compaction cache verification record

On 2026-11-03 (local date), Stage 1's evaluator and matching controller were preserved before the
Stage 2 protocol change. The same four fixtures, instructions, rubric, `gpt-5.6-sol`, and medium
effort were used with three repetitions requested. Both helpers authenticated independently and
kept their credentials only in Go memory.

The first run (`2026-11-04T02-29-52-549Z`) stopped on a provider `server_error` after the blocked
pair passed. The next (`2026-11-04T02-32-53-873Z`) passed both variants of blocked, alternative,
and changed, then stopped while grading the baseline compaction case: repeated raw transcript
copies made its grader request exceed Native Messaging's 1-MiB frame limit. That case had fallen
back to raw history, so it did not establish compaction behavior. Both incomplete reports remain
under ignored build output; neither is a completed three-repetition comparison.

A separate live capability check returned HTTP 401 `hardened_oauth_rule_missing` for
`/responses/compact` with the tested ChatGPT connection. This is an observed restriction for that
connection, not proof about all accounts. Streaming worked. Live compaction comparison remains
**inconclusive** for that dedicated-endpoint implementation. The in-band follow-up below resolves
access on the tested connection. No private endpoint was introduced.

The corrected harness omits repeated transcript bodies and opaque compaction from grader traces,
records compaction availability, and rejects raw-history fallback as evidence for the compaction
fixture. Both preserved and candidate harnesses received that identical correction. Scripted
checks cover successful compaction and this unavailable-route case. Native/browser transition tests
verify bounded handle-only storage, scoped invalidation, refresh/auth changes, restart fallback,
cancellation before worker startup, and continuations without action replay. These establish
implementation behavior; they did not substitute for a live compaction comparison at that point.

## ChatGPT OAuth in-band compaction

Follow-up testing on 2026-11-03 (local date) found a working public route with the existing
OAuth scopes. OpenAI documents [`context_management` on Responses create](https://developers.openai.com/api/docs/guides/compaction#server-side-compaction).
The dedicated `/responses/compact` request returned HTTP 401 `hardened_oauth_rule_missing`, while
`POST /responses` with `store: false`, `stream: true`, and
`context_management: [{type: "compaction", compact_threshold: 1000}]` returned a canonical compaction
item. Reusing that item alone in a fresh stateless request recovered both an older synthetic
codeword and the most recent synthetic milestone. Credentials remained entirely in Go memory.
No additional OAuth scope, browser permission, or private endpoint was used.

The production checkpoint request now uses this streaming route with ordinary base instructions
and no tools. It retains only the latest canonical compaction item; incidental generated text and
reasoning are discarded. A small prefix that produces no checkpoint preserves its prior handle
and remains eligible on later prompts. Ordinary Ask/Act requests do not enable server compaction.

The first paired run (`2026-11-04T02-56-39-446Z`) exposed a semantic error: checkpoint-only developer
instructions were encoded into the opaque state, and all three candidate tasks subsequently replied
“Checkpoint complete” instead of performing the new task. That failed report is retained. The fix
uses the ordinary base policy, with a regression test enforcing the actual request body; it adds no
checkpoint-only instruction that could govern future prompts. Fixtures, model, effort, task budgets,
and rubric stayed fixed for the rerun.

The corrected rerun (`2026-11-04T03-00-17-144Z`) used `gpt-5.6-sol`, medium effort, the same compaction
fixture, unchanged Act instructions and rubric, and three paired repetitions. The preserved
`fc4e88b` evaluator/controller called the dedicated endpoint; the candidate used in-band compaction.
All three candidate tasks used actual opaque checkpoints, inspected both source files, and recalled
the older codeword. Deterministic checks and blinded grading passed **3/3**. The control received
HTTP 401 on compaction in **3/3**, so it failed the checkpoint-availability check while still answering
accurately through raw-history fallback. This demonstrates working compaction on the tested
connection/model, not superior answer quality over that fallback or universal model support.
The comparison exited successfully; its reports and preserved control are ignored local artifacts.

Reproduce the focused comparison after preserving a matching control:

```sh
npm run eval:act -- --model gpt-5.6-sol --effort medium --repeat 3 --scenario compaction \
  --baseline-host build/oauth-compaction-baseline/eval-act \
  --baseline-harness build/oauth-compaction-baseline/source/tests/act-evaluation/harness.mjs
```
