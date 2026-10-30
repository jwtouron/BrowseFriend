# Continuous Integration

The workflow in `.github/workflows/ci.yml` is configured for a public GitHub repository. It runs on
pushes, pull requests, and manual dispatch. No remote is configured yet; hosted execution and its
first green results remain pending until the initial push.

## Native matrix

| Target | Runner | Go race detector |
| --- | --- | --- |
| Linux x64 | `ubuntu-24.04` | Required |
| Linux ARM64 | `ubuntu-24.04-arm` | Required |
| macOS Intel | `macos-15-intel` | Required |
| macOS ARM64 | `macos-15` | Required |
| Windows x64 | `windows-2025` | Required with MinGW-w64 |
| Windows ARM64 | `windows-11-arm` | Unavailable; ordinary tests run |

CI pins Go 1.27.3, Node 24.22.1, and action commit hashes. It asserts the Go and Node architectures
before testing, validates the workflow with actionlint 1.7.12, and checks Go formatting. Each native
job runs `npm run verify`: JavaScript syntax/tests, manifest parsing, Go tests/vet, generated-contract
checks, and execution of the production binary. Installation tests use temporary directories and a
dedicated Windows registry subtree; the installed copy must preserve binary framing and leave saved
account data intact when removed.

## Credential-store isolation

Linux installs `dbus-x11`, `gnome-keyring`, and `libsecret-tools`, then runs verification inside an
isolated D-Bus/Secret Service session with `BROWSEFRIEND_TEST_SECRET_SERVICE=1`.

macOS enables `BROWSEFRIEND_TEST_MAC_KEYCHAIN=1`. The test creates and deletes a disposable Keychain,
uses an explicit keychain path and unique service, and never reads BrowseFriend's real key entry.
It checks key persistence, encrypted-account recovery, and preservation after key corruption.

Windows runs the full native suite, including DPAPI persistence, registry ownership, locked files,
ACLs, and reparse targets. Wine-specific exclusions are not enabled in native CI. No OpenAI account,
real authentication tokens, live model requests, or repository secrets are needed.

## Downloadable builds

After a target's checks pass, CI runs:

```sh
go run ./native-host/cmd/build --check --package
```

This creates `build/packages/browsefriend-<os>-<arch>.tar.gz` on macOS/Linux or `.zip` on Windows,
plus a matching `.sha256` file. The archive contains exactly:

- `browsefriend-native-host` (`.exe` on Windows).
- The project `LICENSE` and `NOTICE.md`.
- Complete dependency licenses in `THIRD-PARTY-NOTICES.txt`.

The packaging tests verify this allowlist, binary contents, executable permissions, stable archive
metadata, and SHA-256 values. Test drivers, test executables, credentials, and other build output are
not package inputs. Go builds the companion with CGO disabled; users need neither Go nor Node.

Successful jobs retain downloadable workflow artifacts for seven days. Download them from the
workflow run's **Artifacts** section, extract the package, and run the companion's `install` command.
Keep the included licenses with redistributed binaries. These are development builds without
release signing/notarization; CI does not create releases or publish to extension stores.

## Local verification and first push

Run `npm run verify`, `git diff --check`, and
`go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12`. To exercise the optional macOS integration
test locally, run `BROWSEFRIEND_TEST_MAC_KEYCHAIN=1 npm run verify`. Linux container and Wine commands
remain documented in [Native companion](NATIVE_HOST.md).

After pushing `master`, inspect the workflow/formatting job and all six native jobs. Configuration
alone does not establish a passing platform result. Record actual hosted results before resolving
the remaining native-verification roadmap items. Manual Chrome sign-in, Ask/Act, restart, and logout
checks remain separate from CI.
