# Third-Party Notice

The optional Go prototype uses `github.com/coreos/go-oidc/v3` v3.21.0 and
`github.com/go-jose/go-jose/v4` v4.1.4 (Apache-2.0), and
`golang.org/x/oauth2` v0.36.0 plus the Go standard library (BSD-style licenses).
The build writes their complete LICENSE/NOTICE texts to
`build/GO-THIRD-PARTY-NOTICES.txt`; include that file when sharing Go binaries.
Go implements the documented public protocol; the retained DevKit and branded sign-in assets
continue to carry the following notices.

BrowseFriend links to the OpenAI Sign in with ChatGPT DevKit pinned at
`vendor/sign-in-with-chatgpt-devkit`.

OpenAI-authored DevKit code and documentation are licensed under the **Sign in
with ChatGPT DevKit Noncommercial License v1.0**. The complete license,
third-party dependency inventory, font licenses, and applicable notices are
preserved inside that submodule.

BrowseFriend keeps the pinned source tree unchanged and applies
`patches/devkit-function-tools.patch` and `patches/devkit-compaction.patch` only while building the
local package. Those downstream patches add the typed function-call transport used by Act mode,
model-supported reasoning-effort selection, and stateless Responses API transcript compaction. They
remain subject to the same DevKit license and notice requirements.

The DevKit license permits personal learning, experimentation, and other
noncommercial development. It does not grant commercial-use rights or rights to
OpenAI trademarks and branded assets beyond their separately authorized use.
Review the pinned license and OpenAI's current Sign in with ChatGPT terms before
redistributing BrowseFriend or changing its intended use.
