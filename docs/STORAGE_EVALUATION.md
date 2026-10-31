# Credential Storage Evaluation

The original comparison ran on 2026-10-30 with Go 1.27.3 and Node 24.22.1. The separate module in
`native-host/storage-evaluation/` contains the experiments. Measurements below describe that baseline;
subsequent production adoption is recorded separately. The account format and real credentials
were not changed by the evaluation or integration tests.

## Recommendation

Keep one AES-GCM account file with an OS-protected encryption key. Pursue a simpler Windows
permission policy that accepts safe inheritance and normal Administrators entries. For this one
account record, the databases tested do not remove enough application code to justify adoption.

Upstream Zalando v0.2.8 passed actual OS-store tests on this Mac, Linux Secret Service, and
Windows Credential Manager under Wine. Its original API cannot cancel a blocked OS lookup;
the legacy evaluation adapter still reproduces that limitation. Production now uses the small
context-aware fork described below rather than that adapter.

Priority is less custom security/recovery code, followed by maintenance, operational simplicity,
then resource cost. No candidate changes the need for Windows testing or Chrome's registry entry.

## Pinned candidates and source review

| Candidate | Version / license | Assessment |
| --- | --- | --- |
| [Zalando](https://github.com/zalando/go-keyring/tree/v0.2.8) | v0.2.8; MIT, with Apache-2.0 headers in the macOS source | Small OS-secret API; no CGO. Best key-provider candidate, with blocking-call limitations. |
| [bbolt](https://github.com/etcd-io/bbolt/tree/v1.4.3) + standard-library AES-GCM | v1.4.3; MIT | Functional reference. Database owns transactions and locking; application still supplies authenticated encryption and account semantics. |
| [Keeper](https://github.com/agberohq/keeper/tree/v0.0.2) | v0.0.2; MIT | Authenticated encrypted KV store over bbolt. Functional, but default key derivation, locking, and lifecycle are a poor fit for short account operations. |
| [Chestnut](https://github.com/jrapoport/chestnut/tree/953a7bc277b485e0de7da2421329161272754d95) | v0.0.0-20241027081206-953a7bc277b4; MIT | AES-GCM/BBolt adapter supplied, but the published dependency graph does not compile. |
| [Badger](https://github.com/dgraph-io/badger/tree/v4.9.6) | v4.9.6; Apache-2.0 | Source-screened only. Its built-in data encryption uses AES-CTR; it does not replace the required authenticated account envelope. |
| [SQLite/Adiantum](https://github.com/ncruces/go-sqlite3/tree/v0.36.0/vfs/adiantum) | go-sqlite3 v0.36.0; MIT | Source-screened only. The VFS explicitly disclaims tamper/forgery protection; an additional authenticated record layer would remain necessary. |

Zalando's reviewed release dates to March 2026; Keeper's to April 2026. Chestnut's latest module
revision is from October 2024 and expects a replacement JSON fork: importing it fails with
`iter.ReadRawString undefined`. Dependency-level `replace` directives do not propagate to consumers.
The Chestnut build probe records this failure; no Chestnut fork, cache edit, or downstream patch was added.
Passing library tests is not a security audit, and a source review is not a runtime result.

Zalando uses `/usr/bin/security` on macOS, D-Bus Secret Service on Linux, and Credential Manager on
Windows. Unlike the original custom Linux adapter, it needs no `secret-tool` executable. Its Linux protocol
uses a `plain` Secret Service session: this concerns local-bus transport, not plaintext storage on
disk. Evaluate that boundary separately if the threat model includes local bus monitoring.

## Storage contract and findings

All runtime candidates store a complete account record, including pending refresh state. The keyring
holds only a 32-byte encryption secret. No account is split among keyring entries.

The shared suite checks 64-byte and 128-KiB synthetic tokens, reopening, failed/wrong keys, modified
ciphertext, oversized-save preservation, logout, concurrent independent processes, and process
termination after a committed refresh checkpoint. A failed identity-verification callback must retain
the saved successor. A separate test cancels the caller and saves with an independent renewal context.
The bbolt reference additionally checks rollback of an interrupted transaction.

Each database is opened for the serialized account operation and closed afterward. Each save commits
independently; wrapping the entire operation in one rollback-on-error transaction would lose the
pending successor. A long-lived database handle would instead block another companion process.

Keeper passed functional recovery and record-tampering checks, but a 10-ms cancellation under lock
contention took approximately five seconds on macOS, Linux, and Wine. Its internal bbolt open has a
fixed five-second timeout. The capability test reports this as an **adoption blocker**, even though
the test successfully reproduces it. Keeper was tested with its default KDF and audit disabled;
custom KDFs or an additional application lock were not introduced to disguise these costs.

The bbolt reference's short open attempts returned cancellation within the suite's 500-ms bound.
Its remaining work includes serialization, record validation, AES-GCM, and application locking scope.
Database adapters are evaluation code, not complete production replacements: they do not implement
all production account validation or filesystem protections.

## Original measurements before integration

macOS ARM64, five reopen/read/write/close cycles after initialization, synthetic 4-KiB access token:

| Storage | First cycle | Mean later cycle | Files / logical disk bytes | Go heap obtained after run |
| --- | ---: | ---: | --- | ---: |
| Existing file | 11.3 ms | 13.9 ms | account + lock / 4,374 | 7.5 MiB |
| bbolt + AES-GCM | 19.8 ms | 12.4 ms | database / 262,144 | 7.5 MiB |
| Keeper defaults | 219.6 ms | 123.6 ms | database / 262,144 | 199.5 MiB |

With a 128-KiB token, later cycles were approximately 16.1, 11.6, and 131.1 ms respectively. These
are local observations, not stable performance thresholds. They exclude OS-keyring latency and
OpenAI traffic. Heap obtained is Go's `HeapSys`, not peak RSS; database mmap and OS caches are not
fully represented. Disk figures are logical sizes, not allocated filesystem blocks.

The combined file/bbolt measurement driver was 7,556,834 bytes and imported 16 non-standard
packages; enabling Keeper produced 10,175,922 bytes and 59 packages. Drivers include shared
evaluation code and are not predicted production-binary sizes. After close, file/bbolt drivers had
one goroutine and Keeper had two. Temporary account directories are removed on exit.

In the original source snapshot, the custom production key providers totaled 144 source lines; the evaluation keyring adapter is 55.
This suggests roughly 89 lines of provider code could be replaced, before deadline integration and
licensing work. It is not a guaranteed net reduction. The database reference is 213 lines plus the
shared account types, while the existing storage file is 173 lines including those types. In
particular, `atomicFile`, private temporary files, directory protection, and replacement behavior
also serve installation, so moving credentials to a DB would not remove those helpers wholesale.

## Windows permission comparison

The alternative accepts safe inherited ACLs, normal Administrators entries, owner read/write/delete
access without full ACL administration, and restrictive deny entries. It still rejects foreign
ownership, broadly shared read/write access, null/empty ACLs, reparse targets, and unknown ACE types.
It is a conservative principal allowlist, not a complete effective-access calculator; Windows still
enforces deny entries and ordinary file access errors. It does not defend against an administrator
or malware already running as the same user, or prove every ancestor of a path safe.

Thirteen policy fixtures passed. Native Windows tests additionally inspect real file descriptors,
safe inherited ACLs, shared permissions, and junctions. Those native tests were cross-compiled but
remain pending; Wine deliberately skips them. No production checks were relaxed. Wine also
reproduced the documented limitation repairing an existing unprotected directory: fixtures must let
the production code create its own fresh private directory, as the production test suite does.

## Verification record and reproduction

- macOS ARM64: race tests, vet, OS Keychain round trips, new-process key recovery, and measurements passed.
- Linux ARM64/Docker: race tests, Secret Service round trips, unavailable-service classification,
  process recovery, and measurements passed.
- Windows x64/Wine 11.20 Staging: storage contracts and Credential Manager round trips passed;
  no race detector or native security-enforcement claim.
- All six macOS/Linux/Windows ARM64/x64 evaluation executables and test binaries cross-compiled.
  Native Windows and the remaining native architectures are pending.
- Production `npm run verify` passed: 110 JavaScript tests plus Go race tests/vet. Workflow
  validation with actionlint 1.7.12 passed. No live authentication/model calls or real account reads.
- The existing production Wine suite also passed, including installation/removal and all ten
  Windows host-contract/configuration checks.

From the repository root:

```sh
node native-host/storage-evaluation/run.mjs check
BF_STORAGE_EVALUATION_KEYRING=1 node native-host/storage-evaluation/run.mjs check
node native-host/storage-evaluation/run.mjs measure
node native-host/storage-evaluation/run.mjs cross
BROWSEFRIEND_WINE="/Applications/Wine Staging.app/Contents/Resources/wine/bin/wine" node native-host/storage-evaluation/run.mjs wine
docker build -f native-host/storage-evaluation/Dockerfile -t browsefriend-storage-evaluation .
docker run --rm browsefriend-storage-evaluation
```

Go must be on PATH; race tests need the normal platform toolchain. `check` includes the known
Chestnut build-failure probe. OS-keyring testing is opt-in, uses unique synthetic entries, and
deletes only those entries. macOS uses the current default keychain without changing its settings;
Linux uses an isolated D-Bus session; Wine uses a disposable prefix. Locked/denied errors are
injected at the adapter boundary rather than locking or denying access to the user's real store.

The runner writes logs and measurement JSON under ignored `build/storage-evaluation/`; Docker prints
its results. Tests use fresh temporary
directories; helpers require an evaluation marker. The normal root Go tests exclude this nested
module. For native CI, manually dispatch **CI** with **storage_evaluation** enabled: it runs the
separate suite on all six existing runners and uploads logs only. First hosted results remain pending.

## Production integration

BrowseFriend now uses the context-support fork in `jwtouron/go-keyring`, retaining upstream import
paths through matching pinned module replacements. Existing account encoding and macOS identifiers
are preserved. Windows uses Credential Manager; Linux no longer needs `secret-tool`. The legacy
keyring adapter above remains an explicit baseline experiment rather than production code.

The fork adds context-aware APIs, cancels/reaps macOS commands, and gives Linux operations private
D-Bus connections with cancellable method/prompt waits and bounded cleanup. Windows native calls
check context before entry and finish synchronously without prompting; cancellation is not rollback.

Production account transactions reuse one key per locked callback and commit each save separately.
Key lookups have a 20-second budget; key creation has an independent commit context. `gofrs/flock`
replaces custom polling and platform lock calls, with private-file validation and held-file identity
checks retained. Transaction key reuse avoids a new OS lookup after receiving rotated credentials.
The evaluation callback seam also exposes a lock-scoped save function, without shared active state.

macOS synthetic OS-keyring/race checks, Linux fork cancellation/OS-store checks, six-target fork
compilation, and Windows x64/Wine companion checks passed. The context fork also passed
[all six native CI targets](https://github.com/jwtouron/go-keyring/actions/runs/41150791174), including Windows. Production Linux and final source-pin
verification are recorded in [Native companion](NATIVE_HOST.md). Broader Windows ACL acceptance
remains unadopted pending native tests; the existing strict policy stays and automatic repair is
removed. Handle any future credential transfer as one-time maintenance, without a migration framework.
