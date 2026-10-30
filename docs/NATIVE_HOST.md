# Native Companion

BrowseFriend's Go companion owns OAuth, protected credentials, model discovery, streaming, and
compaction. The Chrome extension owns chat state, page extraction, and authorized page actions.

## Build and register

Development requires Go 1.25+. JavaScript tests require Node 22.12+; Go race tests require a C compiler.
The installed binary is built with CGO disabled and requires neither runtime.

```sh
go run ./native-host/cmd/build --check
build/browsefriend-native-host install --dry-run
build/browsefriend-native-host install
build/browsefriend-native-host uninstall --dry-run
```

Reload the extension from `chrome://extensions` after installing. The install command copies the
binary and atomically writes the Chrome registration. Uninstall removes its own registration and
executable but preserves account data. Uninstall preserves and reports a conflicting registration.
npm build/test/install commands are development shortcuts; standalone registration needs no Node.

## Storage

macOS stores files under `~/Library/Application Support/BrowseFriend/native-host/`.
Linux uses `$XDG_CONFIG_HOME/browsefriend/native-host/`, defaulting to `~/.config/`.
The directory contains the installed `browsefriend-native-host`, `account.enc`, and `account.lock`.

The entire account record is encrypted with AES-256-GCM. macOS uses Keychain service
`com.browsefriend.native-host.credentials`, account `local-encryption-key`. Linux requires
`secret-tool` and Secret Service, with attributes `application=browsefriend key=native-host-credentials`.
Files are owner-only, writes are atomic, and refreshes are serialized across processes.

There is one current registration. Logout clears access, refresh, and retained ID tokens and attempts
remote revocation, while retaining registration and host identity. An unavailable keyring or damaged
file fails without resetting or replacing saved credentials.

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

The build emits four macOS/Linux ARM64/x64 binaries and `build/THIRD-PARTY-NOTICES.txt`; retain the
notices with distributed binaries. Cross-compilation does not establish platform runtime support.
CI must eventually execute all four target binaries, as specified in the roadmap.

## Verification record

On 2026-10-29, macOS ARM64 passed the full JavaScript suite, Go race tests, vet, and short fuzz runs
for SSE and compacted-context parsing. A production-binary protocol test runs with an empty `PATH`
to check that framing and validation require no language runtime. The installed companion read the
existing local account as signed in after a one-time manual transfer; there is no account-transfer
or legacy fallback code in the application.

Linux ARM64 passed Go race tests and Secret Service integration in Docker, plus execution,
installation, and removal of the standalone binary. macOS x64 and Linux x64 were cross-compiled
but have not received runtime validation. Future CI must execute each target as described above.

The user previously reported successful Go companion use in Chrome on this Mac. After the final
replacement, manually check reconnection, a completed Ask response, a harmless Act continuation,
Stop/Retry, and persistence after Chrome restart. Those browser checks and live account operations
are separate from automated authentication tests.
