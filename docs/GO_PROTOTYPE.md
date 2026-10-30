# Go Companion Evaluation

This prototype tests whether a standalone Go binary can replace BrowseFriend's Node/DevKit
companion. It implements the existing eight Native Messaging operations, direct browser OAuth,
encrypted account storage, refresh recovery, model/effort discovery, streaming, page tools, and
stateless compaction. The extension UI and its authorization rules remain the same.

## Build, verify, and opt in

Development requires Node 22.12+ and Go 1.25+. Race tests also need a C compiler.
The deployed executable is built with CGO disabled and requires neither runtime installed.

```sh
npm run build:host:go
npm run test:host:go
npm run verify
npm run install:host -- --runtime=go --dry-run
npm run install:host -- --runtime=go
```

Reload BrowseFriend from `chrome://extensions` after switching. Complete **Continue with ChatGPT**
again: this prototype has a separate account and keyring entry. Installing selects the same Chrome
host name, so only one implementation is registered at a time.

To return to the existing Node host and its saved account:

```sh
npm run install:host -- --runtime=node
```

The installer copies Go into the platform BrowseFriend data directory's `go-prototype/` folder.
It keeps `account.enc` and `account.lock` there. macOS uses Keychain service
`com.browsefriend.credentials.go-prototype`; Linux uses Secret Service attributes
`application=browsefriend-go-prototype key=credentials`. Uninstall preserves saved account data.
The prototype does not read or migrate the Node account.

## What automated checks establish

- Existing JavaScript tests still run; shared cases exercise Node and the compiled Go test host
  for auth state, consent, revocation warnings, model metadata, input validation, context ordering,
  tools, compacted items, concurrency, and cancellation.
- Go race tests use a local TLS/OAuth provider, signed synthetic identities, and a test encryption
  provider. They cover sign-in, callback rejection, encryption/tampering/permissions, process locks,
  signing-key outage recovery across client restart, logout, HTTP requests, SSE failures, and framing.
- The production binary is also tested with fragmented/malformed Native Messaging frames.
  Test-client code and injectable endpoints/keys are not included in that executable.
- Build generation embeds the current shared policy and tools and emits third-party license texts.
  Keep `build/GO-THIRD-PARTY-NOTICES.txt` with binaries you distribute.

Cross-compile all targets with `node scripts/build-go-host.mjs --cross`.
Initial Go 1.27.3 builds succeeded for macOS/Linux on x64/ARM64, approximately 10.5–11.5 MiB each.
On the development Apple Silicon Mac, ten warm process-start-to-EOF samples had medians of
6.75 ms for Go and 102.12 ms for Node. This measures process startup/shutdown, not OAuth/network or
browser readiness. Cross-compilation does not establish runtime or credential-store compatibility.

## Live browser trial

The user reports successful use of the Go companion in Chrome on this Mac. Individual recovery
scenarios below have not all been reported separately and remain explicit verification steps.

1. Install Go explicitly and reload the extension. Check signed-out UI and complete real sign-in.
2. Confirm account identity, model choices, reasoning options, and a completed Ask response.
3. Try a harmless Act task on a test page, including navigation and a tool continuation.
4. Stop a streaming request, send another prompt, and check settings/new-chat behavior.
5. Restart Chrome and confirm the prototype account resumes without signing in again.
6. Check logout, consent declined, missing helper, offline service, and locked/denied credential-store
   recovery. No credentials or server response bodies should appear in UI errors or the console.
7. Repeat on Linux with Secret Service, then restore Node and verify its saved account is intact.

Live OpenAI requests and real credential-store interactions have not been performed by the automated
suite. Treat these as remaining evaluation work. The prototype supports one registration, has no
credential migration, and is not a signed/notarized installer. Image/file attachments and permanent
replacement of Node remain separate roadmap tasks.
