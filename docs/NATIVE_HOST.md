# Native Companion

BrowseFriend's Go companion owns OAuth, protected credentials, model discovery, streaming,
compaction, and task-scoped Act model context. Opaque compaction lives in a separate 320-KiB native
cache scoped to the conversation, model, and authentication generation; Chrome receives only a handle
and byte count. The Act context remains in Go memory and is released
when the task ends; it is never written into account storage. The Chrome extension owns chat state,
page extraction, and authorized page actions.

## Build and register

Development requires Go 1.25+. JavaScript tests require Node matching `^22.22.2 || ^24.15.0 || >=26.0.0`; Go race tests require a C compiler
(compatible MinGW-w64 on Windows x64). Go does not support the race detector on Windows ARM64;
that target runs ordinary tests and reports the distinction.
The installed binary is built with CGO disabled and requires neither runtime.

If you use mise, `mise install` selects the pinned development tools and `mise run build:host`
wraps `npm run build:host`; installation and test tasks keep the same npm names. Go/npm commands
work independently of mise. See [optional setup](../README.md#optional-mise-setup) for tasks and
platform prerequisites.

```sh
go run ./native-host/cmd/build --check --install
go run ./native-host/cmd/build --check --uninstall
```

Reload the extension from `chrome://extensions` after installing. The install command copies the
binary and atomically writes the Chrome registration. Uninstall removes its own registration and
executable but preserves non-secret registration data. Uninstall preserves and reports a conflicting registration.
npm build/test/install commands are development shortcuts; standalone registration needs no Node.

The built executable also accepts `install`, `uninstall`, and `--dry-run` directly. Windows builds
use `.exe`: for example, `./build/browsefriend-native-host.exe install --dry-run` in PowerShell.
Run installation/removal from the downloaded or build copy. Close BrowseFriend first if Windows
reports that the installed executable is in use; the installer does not kill processes or delete itself.

## Storage

macOS stores files under `~/Library/Application Support/BrowseFriend/native-host/`.
Linux uses `$XDG_CONFIG_HOME/browsefriend/native-host/`, defaulting to `~/.config/`.
Windows uses `%LOCALAPPDATA%\BrowseFriend\native-host\`, discovered through the Windows known-folder API.
The directory contains the installed `browsefriend-native-host`, `registration.json`, and
`registration.lock`. The JSON file contains only non-secret `hostId`, `clientId`, and `subject`.
Credentials, ID tokens, profile details, scopes, and pending refresh successors live only in Go
memory. Chrome restart, extension reload, bridge disconnect, or companion exit requires sign-in
again. A new process reuses registration identifiers without restoring authentication.

Directories and files receive owner-only Unix modes or protected Windows ACLs for the current user
and SYSTEM. Ownership, permissions, and symlink/reparse targets are validated. Existing unsafe
Windows ACLs are rejected rather than repaired. Registration updates use `gofrs/flock` with a
45-second cancellable acquisition limit and held-file identity checks, followed by atomic writes
using flushed private temporary files. Credential operations serialize within the process.

A refresh successor is retained in memory before identity verification; cancellation or a signing-key
outage can recover it in the same process without replaying rotation. Exit discards that checkpoint.
Logout attempts remote revocation and clears local tokens, including pending successors, even if
revocation fails after starting. No account encryption, OS-keyring dependency, migration, legacy
account loading, or cleanup utility remains. Old encrypted files and keyring entries are ignored.

Windows keeps the host manifest beside its executable and registers its absolute path in the
default string value of
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browsefriend.native_host`, using the 32-bit
registry view Chrome checks first. Installation needs no elevation. Uninstall removes only its own
registration value and preserves other registry values/subkeys and non-secret registration data.

There is one selected registration. Logout retains registration identifiers. The
[storage evaluation](STORAGE_EVALUATION.md) archives the retired persistence experiments; their
separate module and CI hooks have been removed.

## Policy and verification

System instructions, tool schemas, efforts, limits, and registration metadata are authoritative in
`shared/host-contract.json`. Go embeds this data; `go generate ./shared` updates the browser module.
The build's `--check` mode fails on generated-file drift.

```sh
npm run verify
go run ./native-host/cmd/build --check --test --cross
go test ./native-host/internal/companion -run=^$ -fuzz=FuzzCompactedContext -fuzztime=5s
go test ./native-host/internal/companion -run=^$ -fuzz=FuzzSSE -fuzztime=5s
docker build -f tests/linux/Dockerfile -t browsefriend-native-tests .
docker run --rm browsefriend-native-tests
```

The tests use local simulated OAuth/TLS providers and synthetic signed identities. They exercise
PKCE binding, identity validation, consent, expiry, pending-refresh recovery, cancellation,
registration locks, registration reuse and credential loss across actual process restarts, unsafe paths,
framing, tool continuations, compaction, and atomic installation. The test driver is separate
from the production binary and adds no injectable credentials/endpoints to the shipped executable.

The Linux container runs race tests/vet and executes the companion and its installer. It needs no
D-Bus session or Secret Service provider. No real ChatGPT credentials or live model requests are used in tests.

The build emits six macOS/Linux/Windows ARM64/x64 binaries and `build/THIRD-PARTY-NOTICES.txt`; retain the
notices with distributed binaries. Cross-compilation does not establish platform runtime support.
`--windows-tests` builds just the Windows target artifacts in addition to the local binaries.
Both `--cross` and `--windows-tests` compile Windows Go tests and the protocol test drivers.
The [CI workflow](CI.md) is configured to execute all six targets natively. Its first hosted runs
remain pending until the initial push; writing the workflow does not mark native verification complete.

Add `--package` to archive the local production binary and its licenses under `build/packages/`,
with a SHA-256 sidecar. The helper packages only its native target, even when combined with `--cross`.

### Compaction protocol

Each `model.compact` and `model.stream` request names a `conversationId`. Compaction returns
`{contextHandle, contextBytes}`; later compaction or the initial generation can reference that handle.
`model.context.clear` accepts a conversation ID and cannot clear a newer conversation's cache.
The native cache never enters files, extension messages, or Chrome storage. The browser retains
only metadata and transcript checkpoints; it reserves the reported bytes in its history budget.
`model.compact` uses a tool-free streaming `/responses` request with documented in-band
`context_management`; it no longer calls the OAuth-rejected `/responses/compact` route. The shared
contract owns its base instructions and 1,000-token provider threshold. Only the latest
canonical compaction item is retained; incidental answer text is discarded. A prefix below the
threshold preserves existing context without disabling later attempts.
An expired handle returns `model_context_lost` before transport. The controller falls back once to
bounded available transcript prose for initial requests, without replaying Act actions. Act
continuations use retained task context and do not resolve the transcript handle again.

## Windows verification commands

Native Windows execution remains pending. On each Windows architecture, run:

```powershell
./tests/windows/verify.ps1
```

This runs the full suite, including native-only ACL/reparse enforcement tests, without touching the
real Chrome registration. Tests use temporary data directories and a dedicated HKCU test subtree.
Manual Chrome sign-in, page interaction, restart, and logout verification is separate.
The configured native CI jobs invoke the same suite; first hosted results are still pending.

For local x64 compatibility checks on macOS/Linux, install Wine and run:

```sh
npm run test:windows:wine
# If Wine is not on PATH (the standard Mac application bundle):
BROWSEFRIEND_WINE="/Applications/Wine Staging.app/Contents/Resources/wine/bin/wine" npm run test:windows:wine
```

The runner initializes a disposable 64-bit prefix with optional desktop/Mono/HTML integration
disabled, compiles both Windows architectures, and runs x64 Go tests and JavaScript host contracts.
It then installs the production executable inside that prefix, reads its signed-out account state,
and unregisters it. It stops only that prefix's Wine server and removes the prefix on completion.
Results are saved to ignored `build/windows-wine-results.json`; failures produce a nonzero exit.
No real ChatGPT credentials or live model calls are involved.

The Wine run uses no race detector. Native-only security-enforcement tests are explicitly skipped
with a pending-verification explanation; the remaining memory/registration storage, locking, registration, and
installer checks still run. Their success under Wine does not certify Windows security enforcement.

## Verification record

Records dated before the process-local authentication change describe the former persistent
credential implementation. They do not verify the current replacement.

On 2026-11-03, process-local authentication passed Linux x64 Go race/vet and the native protocol
suite, all 128 JavaScript tests, workflow linting, and builds for all six targets. Both Windows
architectures' test suites compiled. Actual process tests proved that registration identifiers
survive while credentials do not; synthetic refresh recovery remained confined to one process.
Chrome browser/sign-in/Ask/Act/restart checks, Docker, Wine, and other native platforms were not
available in this environment. The user authorized proceeding on automated verification while
reporting those checks as pending. No live authentication or model requests were made for Stage 1.

On 2026-10-29, macOS ARM64 passed the full JavaScript suite, Go race tests, vet, and short fuzz runs
for SSE and compacted-context parsing. Disposable-Keychain integration, installed-binary checks,
and archive contents/checksums also passed. A production-binary protocol test runs with an empty `PATH`
to check that framing and validation require no language runtime. The installed companion read the
existing local account as signed in after a one-time manual transfer; there is no account-transfer
or legacy fallback code in the application.

Linux ARM64 passed Go race tests and Secret Service integration in Docker, plus execution,
installation, and removal of the standalone binary. macOS x64 and Linux x64 were cross-compiled
but have not received runtime validation. Future CI must execute each target as described above.

On 2026-10-29, Wine 11.20 Staging on macOS ARM64 executed the x64 Windows companion tests,
the command-line and packaging tests, and all ten JavaScript host-contract/configuration checks. Coverage includes
simulated OAuth/model HTTP, encrypted persistence, DPAPI key recovery in a new process, refresh
serialization, cancellation, registration conflicts, and busy-file handling. The installed production
Windows executable reported signed out; dry runs, installation, and repeated uninstallation passed.
Windows ARM64 binaries and tests were compiled only. Native Windows execution, native ACL/reparse
enforcement, Windows race tests, and manual Chrome browser verification remain pending.

Wine 11.20's [`SetSecurityInfo` implementation](https://github.com/wine-mirror/wine/blob/wine-11.20/dlls/advapi32/security.c#L2761)
does not reliably preserve protected-DACL inheritance flags. Directories
and temporary files are therefore created with protected security descriptors from the outset and
always validated afterward; no production check is bypassed for Wine. Existing unsafe directories are rejected; the companion no longer attempts ACL repair.

The user previously reported successful Go companion use in Chrome on this Mac. After the final
replacement, manually check reconnection, a completed Ask response, a harmless Act continuation,
Stop/Retry, and persistence after Chrome restart. Those browser checks and live account operations
are separate from automated authentication tests.

On 2026-10-30, the context-aware keyring integration passed macOS ARM64 race tests and synthetic
Keychain persistence, including the old raw key encoding. The fork passed macOS command cancellation
and child-reaping tests, Linux D-Bus authentication/prompt cancellation and isolated Secret Service
round trips, and compilation for all six targets. Wine x64 passed Credential Manager persistence,
account locking/cancellation, simulated HTTP, the ten JavaScript contracts, and install/uninstall.
Native Windows ACL/reparse enforcement remains pending; Wine is compatibility coverage only.

The integrated companion also passed Linux ARM64 race/vet, synthetic Secret Service persistence,
compiled-binary execution, and install/uninstall checks in Docker on 2026-10-30. The full local
verification suite passed all 110 JavaScript tests plus Go race/vet checks.

The keyring fork subsequently passed
[all six native CI targets](https://github.com/jwtouron/go-keyring/actions/runs/41152685749)
at `1a3d07acf90f17ae74c6a5114b655b8587d45b00`, including Credential Manager tests on Windows x64
(with race detection) and ARM64. This revision merges Zalando upstream through `66b55cc`, including
user listing and Secret Service content-type detection, while retaining context cancellation.
The upstream checker also passed without proposing another merge.

With both module pins updated, BrowseFriend passed all 110 JavaScript tests, macOS ARM64 race/vet
and synthetic Keychain checks, Linux ARM64 Docker race/vet and binary installation/removal, and
Windows x64 Wine Go/JavaScript contracts and installation/removal. Both Windows architectures and
their tests compiled. The separate storage-evaluation checks, including synthetic Keychain access
and the expected Chestnut build-failure probe, passed. Generated dependency notices identify the
new fork revision and retain its MIT/Apache license texts. Fork CI is library-level verification;
BrowseFriend's complete native Windows companion, ACL/reparse enforcement, and manual Chrome checks
remain pending.

On 2026-11-01, task-scoped Act context retention passed 127 JavaScript tests, macOS ARM64 Go race
and vet checks, and Linux ARM64 Docker race/Secret Service and installation/removal checks. Both
Windows architectures and their test binaries compiled; Windows x64 Wine Go tests, eleven JavaScript
contracts/configuration checks, and installation/removal passed with a disposable prefix. Native
Windows security/ARM64 execution and manual Chrome checks remain separate. Real-model comparisons
used only synthetic pages and are recorded in [Act evaluations](EVALUATIONS.md#task-context-verification-record).

On 2026-11-03 (local date), the native compaction cache passed Linux x64 race/vet, Native Messaging
contracts including actual process restart, and all 140 JavaScript tests. All six target binaries
built and both Windows test suites compiled. Workflow linting and diff checks passed. Live paired
runs authenticated with process-local credentials and passed the three existing fixtures on both
variants, but the requested three-repetition comparison remained inconclusive: a provider error,
a corrected grader-trace limit, and HTTP 401 `hardened_oauth_rule_missing` on compaction prevented
completion. See [Act evaluations](EVALUATIONS.md#native-compaction-cache-verification-record).
Manual Chrome layouts/console/restart, Docker, Wine, and native execution on other platforms remain
pending, as authorized for this staged handoff.

A subsequent OAuth capability probe resolved the compaction restriction through documented in-band
compaction on `/responses` with the same scopes. Reusable checkpoints retained older and newer
synthetic facts in a fresh stateless request. The companion now uses that route, preserving the
existing handle-only bridge and Go cache. HTTP/SSE regression coverage checks base-policy retention,
no tools, `store: false`, `stream: true`, checkpoint selection, size bounds, missing checkpoints,
and incomplete/failed streams. See [the follow-up evaluation](EVALUATIONS.md#chatgpt-oauth-in-band-compaction).

The corrected in-band implementation passed all 141 JavaScript tests, Go race tests/vet, all six
binary builds, and both Windows test compilations. Three paired real-model compaction trials passed
3/3 for the candidate, with actual checkpoints, retained older facts, and completed Act tasks.
The preserved dedicated-endpoint control was denied compaction in 3/3 and used raw-history fallback;
its answers were still accurate. An earlier failed checkpoint-policy experiment is retained in the
evaluation record. Manual Chrome and other-platform runtime checks remain separate and pending.
