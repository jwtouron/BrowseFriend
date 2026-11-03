# Act evaluations

`npm run eval:act -- --model <account-model-slug> --effort medium --repeat 1`
always uses the real model and a real rubric grader through the saved BrowseFriend
ChatGPT connection. Sign in through BrowseFriend first. No API key, browser automation,
DevTools MCP, browser registration, or local web server is needed. The command reuses
normal credential refresh and locking; it cannot sign in, log out, or compact a chat.

Install development dependencies with `npm ci`. Node must satisfy
`^22.22.2 || ^24.15.0 || >=26.0.0`; Go 1.25+ is required. The command builds its separate
evaluation helper locally. That helper is not registered or packaged as the production host.

## When to use and extend the harness

Use real-model evaluations when changing Act instructions, retained model context, or tool-loop
behavior that affects the model's decisions. Run ordinary verification first, then compare fixed
model/effort settings over repeated trials. The default comparison isolates instruction changes on
the current implementation; `--baseline-host` compares implementations with identical current
instructions. Preserve that executable before editing implementation code. If the saved account or
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
blocker, working file browsing despite unavailable search, and indexing completing through
a DOM change without navigation. The model chooses its own actions; paths and pages are
not a prerecorded sequence.

The baseline is the original Act instruction text; the candidate is the current shared
contract. Model and effort remain fixed across both. The runner requires an explicit model,
checks catalog choices, and never substitutes a different model or effort. One repetition
runs six tasks and six grader requests; `--repeat N` alternates variant order between repetitions.
Each task allows eight tool calls and five minutes. Exceeding these bounds is failure,
not successful blocker recognition. There are no automatic task retries.

## Compare task context separately

Before modifying the implementation, preserve its evaluator under ignored build output:

```sh
go build -o build/act-context-baseline/eval-act ./native-host/cmd/eval-act
```

After implementing context retention, run:

```sh
npm run eval:act -- --model <slug> --effort medium --repeat 3 --baseline-host build/act-context-baseline/eval-act
```

This uses identical current instructions for both executables, isolating task-context behavior from
instruction changes. Without `--baseline-host`, the original instruction comparison remains available.
Reports identify comparison type and executable hashes. Keep the preserved binary when reproducing
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
Cancellation uses normal model cancellation and waits for Go cleanup/refresh persistence.

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
