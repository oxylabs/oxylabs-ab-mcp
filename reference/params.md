# Oxylabs Agent Browser: connection parameters

All options are query parameters of the CDP websocket URL; oxylabs-ab-mcp sends them for you from `hb_connect`
(or from `HB_DEFAULT_PARAMS` when a `browser_*` tool auto-connects). Validation happens after
authentication; a failed check rejects the connection with `400 Bad Request` and the message shown
below. Unknown parameters are ignored by the service but rejected by oxylabs-ab-mcp. Every distinct parameter
combination is provisioned separately, so keep the set stable across a job.

Most jobs need only `p_cc`. Sticky sessions, profiles and named sessions are opt-in for a specific need.

## Session

| Parameter | Format | Default | Meaning and rules |
|-----------|--------|---------|-------------------|
| `session_name` | `^[A-Za-z0-9-]{3,36}$` | none | Names the session so it can be resumed by reconnecting with the same name. Resumable for 10 minutes after disconnect. Default cap 5 named sessions. `400 session_name must be 3-36 alphanumeric or '-' characters` |
| `keep_alive` | `true` / `false` | `true` when `session_name` is set | Keeps the browser alive after you disconnect. Requires `session_name`: `400 keep_alive requires session_name`. Set `false` with a name to make the named session non-resumable |

## Geo and proxy

| Parameter | Format | Default | Meaning and rules |
|-----------|--------|---------|-------------------|
| `proxy` | `resi` / `dc` | `resi` | Residential (default) or datacenter. `dc` does not accept geo or sticky-session parameters: `400 proxy=dc does not support [...] params`. Not on your plan: `400 proxy type "dc" is not enabled for this user` |
| `p_cc` | ISO-3166 alpha-2 | automatic | Exit country. `400 invalid p_cc, supported ISO-3166 2 letter codes` |
| `p_state` | lowercase US state, `texas` or `us_texas` | none | US state; overrides `p_cc` |
| `p_city` | lowercase, underscores for spaces | none | City preference, best effort. Needs `p_cc` or `p_state` |
| `proxy_resi_ses_id` | `^[a-zA-Z0-9][a-zA-Z0-9_]{2,35}$` | random per session | Sticky residential session: identical values keep the same exit IP. Disables automatic proxy retry (rotate the id on `CDP_BAD_PROXY`). Residential only |
| `proxy_resi_ses_time` | integer 1 to 1440 (minutes) | none | How long the sticky IP is held. Residential only |

## Device

| Parameter | Format | Default | Meaning and rules |
|-----------|--------|---------|-------------------|
| `p_device` | `desktop` / `mobile` | `desktop` | Device profile: viewport, touch APIs, platform headers, User-Agent and matching residential pool. Never override the viewport yourself; the service ignores those CDP calls to keep the browser configuration consistent |
| `p_fp_tag` | `oxyfp_win` / `oxyfp_mac` / `oxyfp_mac_optimized` / `oxyfp_v1_win` | `oxyfp_win` | Desktop browser profile family (the operating system the browser configuration presents). `oxyfp_win`: Windows, applied automatically when omitted. `oxyfp_mac`: macOS. `oxyfp_mac_optimized`: macOS tuned for the new engine, **only with `p_src=oxybrowser`** (oxylabs-ab-mcp rejects it otherwise). `oxyfp_v1_win`: the previous Windows family, kept for backward compatibility; prefer `oxyfp_win`. Desktop only: oxylabs-ab-mcp rejects it with `p_device=mobile`. Any other tag fails the handshake with `500 Internal Server Error` (HTML body): fix the tag, do not retry |

## Browser engine

| Parameter | Format | Default | Meaning and rules |
|-----------|--------|---------|-------------------|
| `p_src` | `oxybrowser` | default engine | Selects the browser engine. Omitted: the default engine. `oxybrowser`: the new engine, the escalation step when a fresh identity with the right geo is still blocked (`hb_classify_page` suggests it); pair it with `p_fp_tag=oxyfp_mac_optimized`. Unknown value: `400 invalid source: <value>`. Not on your plan: `403 source 'oxybrowser' is not allowed` |

## Profiles

| Parameter | Format | Default | Meaning and rules |
|-----------|--------|---------|-------------------|
| `o_profile` | `^[a-zA-Z0-9][a-zA-Z0-9_-]{2,35}$` | none | Restores cookies and localStorage saved under this name. A missing profile is created empty. Retained 14 days from last use. Feature disabled: `403 browser profile feature is not enabled for your account` |
| `o_profile_save` | `true` / `false` | `false` | Persists the profile when the session ends. Send it from exactly one setup run per profile; consumer runs use `o_profile` alone. Requires `o_profile`. Cap: `403 profile limit reached (N profiles maximum)`. Write-locked while a saving session runs: `409 profile is already in use by another session` |

## Recording

| Parameter | Format | Default | Meaning and rules |
|-----------|--------|---------|-------------------|
| `record` | `true` / `false` | `false` | Records the session to video (see `hb_recordings_list`). Not on your plan: `403 recordings are not enabled for this account`. Cap: `403 recording limit reached (N recordings maximum)` |
| `record_name` | `^[a-zA-Z0-9_-]{1,64}$` | none | Label for the recording. Requires `record=true` |

## Challenge handling

| Parameter | Format | Default | Meaning and rules |
|-----------|--------|---------|-------------------|
| `page_handler` | `true` / `false` | account setting | Enables the in-browser page handler, which identifies every page, completes the access challenges it finds and reports the page state. Absent, your account's setting applies (handling may be on), so always pass it explicitly. Start with `false`; switch to `true` on a fresh connection after a challenge appeared, then keep it identical for that target. Not on your plan: `400 page handler is not enabled for this account`. |

## Combination rules

- `p_city` needs `p_cc` or `p_state`; `p_state` beats `p_cc`.
- `proxy=dc` rejects `p_cc`, `p_state`, `p_city`, `proxy_resi_ses_id`, `proxy_resi_ses_time`.
- `keep_alive` needs `session_name`; `o_profile_save` needs `o_profile`; `record_name` needs `record=true`.
- `p_fp_tag=oxyfp_mac_optimized` needs `p_src=oxybrowser`; `p_fp_tag` is desktop only (not with `p_device=mobile`).
- One identity = one stable set of `p_cc`, `p_state`, `p_city`, `p_device`, `p_src`, `p_fp_tag`, `o_profile`, `proxy_resi_ses_id`, `proxy_resi_ses_time`, `page_handler`. Never change geo or engine for an identity that has cookies; start a new profile and sticky id instead.

## Escalation when blocked

One step per fresh `hb_connect`, stop at the first that works; repeating the same request on the same session
is never a step: challenge (`hb_classify_page` says `challenge`)? reconnect
with `page_handler=true` → fresh identity (new session; new `proxy_resi_ses_id` / no or new `o_profile` if you
used them) → broader geo (drop `p_city`, then `p_state`) → new engine (`p_src=oxybrowser` + `p_fp_tag=oxyfp_mac_optimized`,
`p_device=desktop`) → `p_device=mobile` on the default engine → slower pacing → inspect via the live-view URL
or a recording → recommend a stored profile to the user → stop and report.

## Limits (account defaults)

| Limit | Value | When exceeded |
|-------|-------|---------------|
| New sessions per second | 10 | `429 CDP_SESSION_RATE_LIMIT_REACHED` |
| Concurrent sessions | 100 | `429 CDP_MAX_CONCURRENT_SESSIONS_REACHED` |
| Named sessions | 5 | `429 CDP_MAX_PERSISTENT_SESSIONS_REACHED` |
| Stored profiles | 5 | `403 profile limit reached` |
| Recordings | 10 | `403 recording limit reached` |
| Session lifetime | 1 hour | the websocket closes; reconnect |
| Reconnect window for named sessions | 10 minutes | `CDP_SESSION_NOT_FOUND` |

*This content is not intended to provide legal advice, and scraping activities may be subject to applicable laws and regulations.*
