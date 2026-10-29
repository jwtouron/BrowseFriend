# Third-Party Notice

BrowseFriend links to the OpenAI Sign in with ChatGPT DevKit pinned at
`vendor/sign-in-with-chatgpt-devkit`.

OpenAI-authored DevKit code and documentation are licensed under the **Sign in
with ChatGPT DevKit Noncommercial License v1.0**. The complete license,
third-party dependency inventory, font licenses, and applicable notices are
preserved inside that submodule.

BrowseFriend keeps the pinned source tree unchanged and applies
`patches/devkit-function-tools.patch` only while building the local package. That downstream patch
adds the typed function-call transport used by Act mode and remains subject to the same DevKit
license and notice requirements.

The DevKit license permits personal learning, experimentation, and other
noncommercial development. It does not grant commercial-use rights or rights to
OpenAI trademarks and branded assets beyond their separately authorized use.
Review the pinned license and OpenAI's current Sign in with ChatGPT terms before
redistributing BrowseFriend or changing its intended use.
