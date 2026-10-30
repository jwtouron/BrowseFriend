# Third-Party Notice

The Go native companion links to:

- `github.com/coreos/go-oidc/v3` v3.21.0 and `github.com/go-jose/go-jose/v4` v4.1.4 (Apache-2.0).
- `golang.org/x/oauth2` v0.36.0 and the Go standard library (BSD-style licenses).

The Go build writes complete linked-module LICENSE/NOTICE texts to
`build/THIRD-PARTY-NOTICES.txt`. Include this file when sharing binaries.

The ChatGPT sign-in SVG in `extension/auth/assets/` was retained unchanged from OpenAI's
Sign in with ChatGPT DevKit, commit `0a36fef`. Its accompanying original license is preserved as
`OPENAI-LICENSE.txt`. OpenAI marks remain subject to the
[OpenAI brand guidelines](https://openai.com/brand/); the code license does not grant trademark rights
or permission to imply endorsement. The SDK runtime and its build patches have been removed.

BrowseFriend implements OpenAI's documented public OAuth and Responses protocol directly. Removing
a runtime dependency does not expand rights to copied assets or change the service's terms.
