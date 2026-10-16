# Oxylabs Agent Browser: challenge handling

The remote browser has a built-in **page handler** for the access challenges websites show. It is switched
on per connection with `page_handler=true` (hb_connect), identifies
every page, completes the challenges it finds and reports the page state that oxylabs-ab-mcp collects
(`hb_page_status`, `hb_session_info`, `hb_classify_page`).

## When to enable it

- Start every target with `page_handler=false`; most pages never show a challenge and handling adds time.
  Absent, the account setting applies (handling may be on), so always pass it explicitly.
- Switch to `page_handler=true` on a **fresh** `hb_connect` as soon as the plain attempt shows a block or
  verification page instead of the expected content. Then keep it on for every connection to that target (a
  flapping value also costs sessions).
- Not every block is a challenge the handler acts on. A `failed` state, or an `open` state while the page is
  still a block page, is the site's decision about this visitor: fresh identity (new `proxy_resi_ses_id`, new
  or no `o_profile`), not more waiting.

## Page state

The runtime reports `oxylabs-page-status` for every page (a `window` message, also printed as the console line
`oxylabs-page-status - {json}`); oxylabs-ab-mcp reads the message through an init script, since the remote browser
emits no live console events. `status` is one of:

| `status` | Meaning |
|----------|---------|
| `identifying` | The page is being checked: at load, after an in-page navigation (`history.pushState` or hash change), and as the acknowledgement of `hb_page_handle`. |
| `closed` | A challenge was found and is being handled; the page is not usable yet. |
| `open` | The page is usable: nothing found (about 8 s after load), or the challenge was handled (typically 30-45 s). |
| `failed` | The challenge was not handled; `error` says why: `bad_token` (the page rejected the token), `token_not_applied` (the token found nothing to go to), `acceptance_inconclusive` (the page neither accepted nor rejected it in time), `challenge_params_timeout` (the challenge page's parameters never arrived), or `handling_failed` (anything else). Always preceded by a `closed`. |

oxylabs-ab-mcp records them per page as `status` and `reason`; `open` and `failed` are the terminal ones to wait for.
A page that went `closed` then `open` had a challenge handled; one that went straight to `open` had none.
Wait up to 90 s. A page that navigates or changes after the state is normal: take a new `browser_snapshot`,
do not reload. A later state replaces an earlier one: a challenge that appears after an `open` closes the
page again (`closed`, then `open` or `failed`), so check `hb_page_status` before trusting a page that changed.

## Detect the block: `hb_classify_page`

| Verdict | Meaning | Action |
|---------|---------|--------|
| `navigation-error` | the navigation got no response (`net::ERR_*`, browser error page) | retry once after a pause; same identity |
| `oxylabs-network` | `X-Error-Description` on the response: the network, not the site | retry |
| `challenge` | an access challenge the page handler acts on (verification interstitial, challenge frame, or a `failed` state) | reconnect with `page_handler=true`, wait for the page state, re-check; `hb_page_handle` if it appeared after load |
| `hard-block` | a block page the handler does not act on (`403` with a vendor block page or an access-denied page with a reference id) | fresh identity, then the escalation ladder |
| `soft-block` | login wall, empty content, `/blocked` redirect | if the content is only available after login, stop (only publicly available data is in scope); otherwise fresh identity and slower pacing |
| `restricted-target` | CDP `1337 Invalid target` | do not retry; ask the account manager |
| `target-error` | error status without a block signature | check the URL, retry once, then treat as a block |

## Challenge appears late, or never renders

- A challenge that appears after page load (click, form submit) is not handled automatically: call
  `hb_page_handle`; the handler identifies the page again, completes what it finds and reports the page state.
  `already-handled` means the handler had completed a challenge on this document before the call and found nothing
  new: the page is usable. `no-runtime` means nothing acknowledged the request: the page is not an http(s)
  document the runtime runs on; navigate again.
- If a challenge never renders (blank frame, `open` without a `closed` although the page looks challenged),
  resource blocking is the usual cause: allow images/styles for this target and retry once.

## On a `failed` state

Do not keep hammering the same session. `hb_disconnect`, back off (10 s, doubling), `hb_connect` as a
fresh identity, same geo and device, `page_handler=true` still on. At most 2 more attempts, then stop and
report that the challenge could not be completed right now (URL, verdict, parameter set, session id, states).

## With identities and profiles

The parameter set is one identity. If the target needs the page handler, `page_handler=true` goes on the
setup run (`o_profile` + `o_profile_save=true`) **and** every consumer run (`o_profile` alone), identically. A
profile that starts drawing challenges on consumer runs is stale: run setup again under a new profile name
and a new sticky id.

*This content is not intended to provide legal advice, and scraping activities may be subject to applicable laws and regulations.*
