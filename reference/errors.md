# Oxylabs Agent Browser: error catalogue

How errors reach oxylabs-ab-mcp:

1. **Handshake** (`hb_connect` or the first `browser_*` call fails): HTTP status plus a short text body.
   oxylabs-ab-mcp retries `429`, `5xx`, `CDP_SESSION_IN_USE`, `CDP_NO_BROWSERS_AVAILABLE`, `CDP_BROWSER_OVERWORKED`,
   `CDP_BAD_PROXY`, `CDP_GENERAL_ERROR` and timeouts with backoff; `400`, `401`, `403`, `409` are reported
   at once and must not be retried unchanged.
2. **Session dropped** (a `browser_*` call reports the target/browser closed): the service closed the
   websocket with a `CDP_*` reason. The next `browser_*` call (or `hb_connect`) opens a new session.
3. **In-page CDP error `1337`**: one command was refused, the session is fine. `Page.navigate` with
   `Invalid target` means the host is restricted for your account.
4. **Target traffic**: a response carrying `X-Error-Description` is an Oxylabs network error (retry);
   a block page without it is the target's decision (change approach). `hb_session_info` lists them.

## 401 Unauthorized

| Body | Cause | Fix |
|------|-------|-----|
| `missing auth header` | no Authorization header reached the gateway | oxylabs-ab-mcp always sends one; a proxy in between is stripping it |
| `invalid auth header` / `not a valid base64 string` / `missing credentials` | malformed Basic token | oxylabs-ab-mcp builds it; if it persists, change a password containing `:` |
| `invalid credentials` | unknown/inactive user, wrong password, incomplete username | check `OXY_HB_USERNAME` (full username incl. suffix) and `OXY_HB_PASSWORD` |

## 400 Bad Request

| Body | Fix |
|------|-----|
| `invalid_uri, invalid query: p_device must be one of [desktop mobile]` | use `desktop` or `mobile` |
| `session_name must be 3-36 alphanumeric or '-' characters` | fix the name |
| `keep_alive requires session_name` | add `session_name` or drop `keep_alive` |
| `unsupported proxy type "x", supported: resi, dc, ddc` | use `resi` or `dc` |
| `proxy type "x" is not enabled for this user` | drop `proxy` or ask support |
| `proxy=dc does not support [...] params` | remove geo/sticky parameters or use `resi` |
| `invalid p_cc, supported ISO-3166 2 letter codes` | two-letter country code |
| `proxy_resi_ses_id must be 3-36 alphanumeric characters or underscores` | fix the id |
| `proxy_resi_ses_time must be between 1 and 1440` | minutes in range |
| `o_profile must contain only letters, numbers, hyphens, and underscores (min 3, max 36 characters)` | fix the name |
| `o_profile_save requires o_profile to be set` | add `o_profile` |
| `record_name requires record=true` | add `record=true` |
| `page handler is not enabled for this account` | drop `page_handler` or ask support |

## 403 Forbidden

| Body | Fix |
|------|-----|
| `browser profile feature is not enabled for your account` | remove `o_profile`; ask support |
| `profile limit reached (N profiles maximum)` | `hb_profiles_list` + `hb_profile_delete`, or reuse a name |
| `recordings are not enabled for this account` | remove `record` |
| `recording limit reached (N recordings maximum)` | `hb_recordings_list` + `hb_recording_delete` |

## 409 Conflict

| Body | Fix |
|------|-----|
| `profile is already in use by another session` | a saving run holds the profile: wait 30 s+, or connect with `o_profile` alone (no `o_profile_save`) |

## 429 Too Many Requests

| Body | Cause | Fix |
|------|-------|-----|
| `CDP_SESSION_RATE_LIMIT_REACHED` | more than 10 new sessions within a second | space launches out; oxylabs-ab-mcp backs off |
| `CDP_MAX_CONCURRENT_SESSIONS_REACHED` | concurrency cap; unclosed sessions count ~20 s, named ones 10 min | `hb_sessions_list`, `hb_session_stop`; always end with `browser_close` / `hb_disconnect` |
| `CDP_MAX_PERSISTENT_SESSIONS_REACHED` | cap of named sessions (default 5) | reuse a name or let old ones expire |
| `CDP_SESSION_IN_USE` | the named session still has a live connection | close it, retry |
| `max queue sessions reached` | too many connections waiting for capacity | lower parallelism |

## 5xx

| Status / body | Fix |
|---------------|-----|
| `500 CDP_GENERAL_ERROR` | retry with backoff; contact support if it persists |
| `502`, `504` | edge/network issue; retry with backoff |
| `503 queue timeout` | waited about a minute for capacity; back off 30-60 s |

## Session dropped (websocket close 3000)

| Reason | Fix |
|--------|-----|
| `CDP_NO_BROWSERS_AVAILABLE`, `CDP_BROWSER_OVERWORKED_*` | retry with backoff |
| `CDP_BAD_PROXY` | rotate `proxy_resi_ses_id`, drop `p_city` |
| `CDP_SESSION_NOT_FOUND` | named session expired (10 min); start a new one |
| `CDP_SESSION_IN_USE` | another connection grabbed the named session first |
| `CDP_GENERAL_ERROR` | browser died; new session with backoff |

## In-page CDP errors (code 1337)

| Message | Fix |
|---------|-----|
| `Invalid target` | restricted category for your account: do not retry; ask your account manager |
| `Too many targets` | over 1000 pages in one session; close pages |
| `Proxy not allowed in this context` | choose the proxy with connection parameters, not per context |

## Decision flow

```text
connect failed?
  ├─ 401 ............ fix credentials, do not retry
  ├─ 400/403/409 .... fix the named parameter, do not retry unchanged (409: wait 30 s+)
  ├─ 429 ............ backoff; if MAX_CONCURRENT: hb_sessions_list / hb_session_stop
  └─ 5xx/503 ........ backoff, up to ~2 min total (oxylabs-ab-mcp does this)
session dropped?
  └─ new session with backoff; rotate sticky id on CDP_BAD_PROXY
navigate failed with 1337 Invalid target?
  └─ stop; restricted target
page shows block / 403 wall?  -> hb_classify_page
  ├─ X-Error-Description present .... Oxylabs network issue: backoff + retry
  └─ absent ......................... target decision: challenge handling, fresh identity, geo, device, pacing
```

*This content is not intended to provide legal advice, and scraping activities may be subject to applicable laws and regulations.*
