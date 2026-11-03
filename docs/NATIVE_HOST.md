# Native Companion

BrowseFriend's Go companion owns OAuth, protected credentials, model discovery, streaming,
compaction, and task-scoped Act model context. That context remains in Go memory and is released
when the task ends; it is never written into account storage. The Chrome extension owns chat state,
page extraction, and authorized page actions.

## Build and register

Development requires Go 1.25+. JavaScript tests require Node matching `^22.22.2 || ^24.15.0 || >=26.0.0`; Go race tests require a C compiler
(compatible MinGW-w64 on Windows x64). Go does not support the race detector on Windows ARM64;
that target runs ordinary tests and reports the distinction.
The installed binary is built with CGO disabled and requires neither runtime.

```sh
go run ./native-host/cmd/build --check --install
go run ./native-host/cmd/build --check --uninstall
```

Reload the extension from `chrome://extensions` after installing. The install command copies the
binary and atomically writes the Chrome registration. Uninstall removes its own registration and
executable but preserves account data. Uninstall preserves and reports a conflicting registration.
npm build/test/install commands are development shortcuts; standalone registration needs no Node.

The built executable also accepts `install`, `uninstall`, and `--dry-run` directly. Windows builds
use `.exe`: for example, `./build/browsefriend-native-host.exe install --dry-run` in PowerShell.
Run installation/removal from the downloaded or build copy. Close BrowseFriend first if Windows
reports that the installed executable is in use; the installer does not kill processes or delete itself.

## Storage

macOS stores files under `~/Library/Application Support/BrowseFriend/native-host/`.
Linux uses `$XDG_CONFIG_HOME/browsefriend/native-host/`, defaulting to `~/.config/`.
Windows uses `%LOCALAPPDATA%\BrowseFriend\native-host\`, discovered through the Windows known-folder API.
The directory contains the installed `browsefriend-native-host`, `account.enc`, and `account.lock`.

The entire account record is encrypted with AES-256-GCM. The keyring entry uses service
`com.browsefriend.native-host.credentials`, account `local-encryption-key`, through the pinned
`jwtouron/go-keyring` context-support fork. This preserves the existing macOS entry and encoding.
Linux uses Secret Service directly over D-Bus, without `secret-tool`. Windows uses Credential Manager;
new installations do not create `key.dpapi`. No automatic account-migration framework is shipped.

Directories and files receive owner-only Unix modes or protected Windows ACLs for the current user
and SYSTEM. Owner, permissions, and symlink/reparse targets are validated. Existing unsafe Windows
ACLs are rejected rather than repaired. `gofrs/flock` locks a separately validated file and verifies
its identity before entering an account transaction. Key reuse is limited to that transaction;
each save atomically commits using flushed private temporary files. Unreadable, missing, or corrupt
keys never cause an existing account to be silently reset.

Lock acquisition has a 45-second limit; key lookups have a 20-second budget. Key creation finishes
under an independent 20-second commit context before the account lock is released. Atomic saves,
refresh successor persistence, and local logout cleanup have explicit commit/recovery boundaries.
Windows credential calls are synchronous and do not prompt; context is checked before they start,
but a native call cannot be interrupted. macOS commands and Linux waits support cancellation;
Linux resource cleanup can add up to two seconds per cleanup call. An accepted write cannot be
rolled back merely because the caller stopped waiting.

Windows keeps the host manifest beside its executable and registers its absolute path in the
default string value of
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browsefriend.native_host`, using the 32-bit
registry view Chrome checks first. Installation needs no elevation. Uninstall removes only its own
registration value and preserves other registry values/subkeys and saved account data.

There is one current registration. Logout clears access, refresh, and retained ID tokens and attempts
remote revocation, while retaining registration and host identity. An unavailable keyring or damaged
file fails without resetting or replacing saved credentials.

The isolated [storage evaluation](STORAGE_EVALUATION.md) measures library and permission-policy
alternatives with synthetic accounts. It has its own module and commands; it records the baseline comparison and subsequent production integration. Its legacy keyring
adapter deliberately retains the upstream cancellation-limit probe.

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
interprocess locks, persistence across actual process restarts, encrypted storage failures,
framing, tool continuations, compaction, and atomic installation. The test driver is separate
from the production binary and adds no injectable credentials/endpoints to the shipped executable.

The Linux container uses an isolated D-Bus session and Secret Service keyring. It executes the
companion and its installer. No real ChatGPT credentials or live model requests are used in tests.

The build emits six macOS/Linux/Windows ARM64/x64 binaries and `build/THIRD-PARTY-NOTICES.txt`; retain the
notices with distributed binaries. Cross-compilation does not establish platform runtime support.
`--windows-tests` builds just the Windows target artifacts in addition to the local binaries.
Both `--cross` and `--windows-tests` compile Windows Go tests and the protocol test drivers.
The [CI workflow](CI.md) is configured to execute all six targets natively. Its first hosted runs
remain pending until the initial push; writing the workflow does not mark native verification complete.

Add `--package` to archive the local production binary and its licenses under `build/packages/`,
with a SHA-256 sidecar. The helper packages only its native target, even when combined with `--cross`.

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
with a pending-verification explanation; the remaining storage, Credential Manager, locking, registration, and
installer checks still run. Their success under Wine does not certify Windows security enforcement.

## Verification record

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
