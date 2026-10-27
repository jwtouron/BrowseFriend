# Known Limitations

BrowseFriend currently requires a separately installed native companion. During development that
companion requires Node.js. A future distributable should bundle its runtime in signed platform
installers instead of asking users to install Node themselves.

Chrome communicates with the companion through Native Messaging over standard input/output; the
companion is not a permanent localhost service. **Continue with ChatGPT** temporarily opens a
random loopback listener only while completing the hosted OAuth callback.

## Page understanding

- BrowseFriend reads ordinary HTTP and HTTPS top-level documents only. Chrome-internal pages,
  extension pages, file URLs without separate access, incognito pages without separate access, and
  embedded frames are unavailable in this version.
- Page context is derived from the rendered DOM and ARIA markup, not Chrome's computed
  accessibility tree. Canvas pixels, image-only content, closed shadow roots, CSS-only changes,
  and some custom controls may be missing or incomplete.
- The pinned OpenAI DevKit accepts text messages only. BrowseFriend cannot send screenshots or
  other images to the model, and the DevKit does not expose model tool calls for requesting more
  page context.
- Required site access produces Chrome's broad read/change warning even though Ask mode does not
  intentionally modify pages.

## Chat behavior

- BrowseFriend automatically uses the first model returned for the connected account.
- Conversations use `store: false` and do not create ChatGPT history entries. They are held in
  Chrome's memory-only session storage and disappear after browser restart, extension reload,
  extension update, or disable.
- Responses are based on a captured page revision. BrowseFriend reports when the page changes but
  does not restart an answer automatically.

Revisit these constraints when the DevKit adds multimodal input or tool calling, OpenAI supports a
pure-extension authentication flow, or packaged companion installers become available.
