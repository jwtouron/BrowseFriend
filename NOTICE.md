# Third-Party Notice

BrowseFriend-authored code is licensed under the [MIT License](LICENSE). That grant does not
relicense third-party dependencies or OpenAI artwork, names, and marks.

The Go native companion links to:

- `github.com/coreos/go-oidc/v3` v3.21.0 and `github.com/go-jose/go-jose/v4` v4.1.4 (Apache-2.0).
- `golang.org/x/oauth2` v0.36.0, `golang.org/x/sys` v0.47.0 (Windows integration), and the Go standard library (BSD-style licenses).
- `github.com/gofrs/flock` v0.13.1 (BSD-3-Clause).
- The context-support fork at `github.com/jwtouron/go-keyring`, retaining upstream module path
  `github.com/zalando/go-keyring` (MIT, with inherited Apache-2.0 macOS source headers).
- `github.com/godbus/dbus/v5` v5.2.2 (BSD-2-Clause) and `github.com/danieljoos/wincred` v1.2.3 (MIT).

The Go build writes complete LICENSE/NOTICE texts for dependencies across all target platforms to
`build/THIRD-PARTY-NOTICES.txt`. Include this file when sharing binaries.

The separate storage-evaluation module adds development-only dependencies, including bbolt, Keeper, and Chestnut. Their licenses and pinned versions are recorded in
[Storage evaluation](docs/STORAGE_EVALUATION.md) and its module files. Those database candidates are not linked into
the production companion or included in its archives; evaluation executables are not release artifacts.

The ChatGPT sign-in SVG in `extension/auth/assets/` belongs to OpenAI and was retained unchanged
from the [Sign in with ChatGPT DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit), commit
`0a36fef`. The artwork is outside BrowseFriend's MIT grant. Its use remains subject to the
[OpenAI brand guidelines](https://openai.com/brand/) and
[Sign in with ChatGPT terms](https://openai.com/policies/sign-in-with-chatgpt-terms/), including the
restriction against implying endorsement. No DevKit runtime code or build patches remain in the
current tree. The DevKit code license excludes branded visual assets and is not an artwork license.

BrowseFriend implements OpenAI's documented public OAuth and Responses protocol directly. Removing
a runtime dependency does not expand rights to copied assets or change the service's terms.
Earlier revisions containing DevKit code or patches retain their applicable original terms.
