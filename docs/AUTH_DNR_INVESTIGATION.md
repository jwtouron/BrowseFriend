# DNR OAuth callback investigation

Investigated on 2026-11-03. Chrome's declarativeNetRequest (DNR) can redirect a loopback
OAuth callback to an extension page without a listener at the callback address. A synthetic
browser probe demonstrated this mechanism. It does not establish OpenAI support for this
callback delivery method or for browser-side token handling. The extension-only proposal was
superseded: retain Go Native Messaging and the documented loopback callback, with authentication
held only in companion memory. This investigation remains a record of the alternative considered.

## Browser feasibility

[Chrome's DNR reference](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
documents redirects before a request is sent, redirects to extension resources, regex capture
substitution, and temporary session rules with tab restrictions. The callback page must be
[web accessible](https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources).
BrowseFriend would need `declarativeNetRequestWithHostAccess` and a narrowly exposed callback
page. Its existing HTTP host permission already covers loopback; the actual rule must restrict
the exact scheme, address, selected port, path, method, and sign-in tab.

Create a blank sign-in tab, install and await the rule, then navigate that tab to authorization.
Opening authorization before installing the rule introduces a race on fast returning sign-ins.
For example, with a synthetic callback port of 1455:

```js
await chrome.declarativeNetRequest.updateSessionRules({
  addRules: [{
    id: 1,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        regexSubstitution: chrome.runtime.getURL("callback.html") + "#\\1"
      }
    },
    condition: {
      regexFilter: "^http://127\\.0\\.0\\.1:1455/auth/callback\\?([^#]*)$",
      isUrlFilterCaseSensitive: true,
      resourceTypes: ["main_frame"],
      requestMethods: ["get"],
      tabIds: [signInTabId]
    }
  }]
});
```

This preserves the whole query as the extension page's fragment, including `code`, `state`,
issued `client_id`, `scope`, and OAuth error parameters. An `extensionPath` destination alone
does not express query copying. Parse with `URLSearchParams`, reject duplicate security
parameters, validate the pending attempt and sender, and clear the callback URL promptly.
Fragments still contain sensitive data and must not be logged or persisted.

Session rules support `tabIds` and do not persist across browser sessions, but still need
explicit cleanup on completion, denial, cancellation, timeout, tab closure, and lost attempt
state. Account for extension service-worker suspension. Treat direct visits to the exposed
callback page as untrusted; neither a matching URL nor a matching rule authenticates a callback.

## OpenAI protocol and BrowseFriend fit

OpenAI's [registration and sign-in guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
explicitly instructs the client to start a loopback listener before opening the browser.
It specifies `http://127.0.0.1:<port>/auth/callback` and the same exact redirect URI in
authorization and code exchange. DNR could leave that protocol parameter unchanged while
changing browser delivery, but this is an inference about compatibility, not documented support.
Do not send the extension page URL as the token exchange's `redirect_uri`.

The proposed flow must preserve new-registration `client_id` handling, OAuth errors, state,
PKCE, nonce, ID-token verification, and account binding. Capturing an authorization code alone
does not finish sign-in. Browser-side token exchange and refresh have not been tested here.

OpenAI's [credential-security guidance](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#credential-security)
says to keep access, refresh, and retained ID tokens in protected runtime storage and out of
browser storage. DNR provides no credential store. Encrypting tokens in browser storage does
not establish compliance with that guidance or our OS-backed-key requirement.

BrowseFriend currently keeps OAuth, PKCE state, verification, token exchange, refresh, and
encrypted credentials in the native companion. Extension messages carry sanitized account
state. Routing a code through an extension page and the bridge would expand that boundary
and require an explicit design change. Keeping the native host for tokens would still require
installation while replacing its short-lived listener with additional browser coordination.
The host also currently launches the system default browser; DNR only operates in the browser
profile containing the extension, so sign-in would need to start through that extension.
No production component boundaries or permissions were changed by this investigation.

## Selected direction

Retain the Go companion for OAuth, model transport, and Act context. Remove authenticated-session
persistence across process/browser restarts. Retain only non-secret host/client/account registration
identifiers in an owner-protected native file; no encryption or OS keyring is needed for those IDs.
The current encrypted credential implementation will be replaced in Stage 1, with no legacy-data
migration or cleanup utility. Install and uninstall remain npm/mise commands without administrator
access. Improved acquisition/setup guidance is deferred until versioned GitHub releases exist.

After Stage 1 passes verification, Stage 2 moves the opaque compacted-conversation payload into
bounded Go memory. Chrome retains a handle and transcript checkpoint. Visible chat, page previews,
settings, authorization, and confirmations remain browser-owned. Historical snapshots and shared
Node/Python/PowerShell/JVM helpers are outside this change.

Chrome's session-storage quota is shared and counts estimated allocated memory, not just UTF-8
payload bytes. It does not constrain the native Act buffer. The extension-only alternative would
have needed a combined quota budget and a solution to worker suspension; those implementation
changes are no longer planned. Browser-side token handling also remains undocumented by OpenAI.

## Verification record

A disposable unpacked MV3 extension ran in headless Brave on Linux, reporting Chromium
`156.0.8078.48`. A local mock authorization endpoint returned an HTTP 302 to a separate
`127.0.0.1:<port>/auth/callback` address with no callback listener. The extension installed a
session rule restricted to its created sign-in tab before starting navigation.

- The extension callback page loaded and recovered the synthetic code `synthetic+code&value`
  from `code=synthetic%2Bcode%26value`; state, issued client ID, and scope also survived.
- The extension removed the session rule after receiving the callback; querying session rules
  then returned an empty list.
- DNR's `testMatchOutcome` matched the intended request and rejected six negative controls:
  another path, port, host, tab, an XHR request, and a POST request. These controls tested rule
  matching, not six additional real navigations.

This was a synthetic browser-mechanism experiment, separate from BrowseFriend's production
extension and account. It used no OpenAI credentials and made no live model or OAuth request.
It did not test OpenAI acceptance, token exchange, production state/nonce validation, suspension
recovery, or Google Chrome 141 (BrowseFriend's minimum). Brave/Chromium results do not certify
all Google Chrome versions or an end-to-end supported OpenAI sign-in flow.
