# Changelog

All notable changes to oxylabs-ab-mcp are documented here. The format follows Keep a Changelog.

## [0.1.0] - 2026-10-15

Initial release.

### Added

- Playwright MCP (`@playwright/mcp`) hosted in-process and pointed at an Oxylabs Agent Browser session
  through its `contextGetter` hook; all `browser_*` tools proxied unchanged.
- Multi-session mode: `hb_connect` returns a session label; every `browser_*` and per-session `hb_*` tool
  takes it as its `session` argument, so there is no implicit current session. Each session runs its own
  Playwright MCP backend, so sessions in different countries can be driven in parallel.
  `hb_disconnect(all=true)` closes everything; `hb_session_info` lists all open sessions with their page
  states. `HB_MAX_SESSIONS` (default 5) caps them.
- `hb_connect` public connection parameters: `p_cc`, `p_state`, `p_city`, `p_device`, `p_src` (`oxybrowser`),
  `p_fp_tag` (`oxyfp_win`, the default; `oxyfp_mac`; `oxyfp_mac_optimized`, only with `p_src=oxybrowser`;
  `oxyfp_v1_win`), `proxy`, `proxy_resi_ses_id`, `proxy_resi_ses_time`, `session_name`, `keep_alive`,
  `o_profile`, `o_profile_save`, `record`, `record_name`, `page_handler`. Validated client-side
  (`keep_alive` requires `session_name`, `oxyfp_mac_optimized` requires `p_src=oxybrowser`, no `p_fp_tag` with
  `p_device=mobile`), with connect backoff, session id and live-view URL. `--default-params` /
  `HB_DEFAULT_PARAMS` apply a query string to every session.
- Challenge handling through the in-browser page handler: `page_handler=true` (absent: the account setting
  applies, so pass it explicitly) switches it on per connection. Page states are read from the runtime's
  `oxylabs-page-status` `window` message (`identifying`, `closed`, `open`, `failed` with `error` from the
  runtime's closed set: `bad_token`, `token_not_applied`, `acceptance_inconclusive`,
  `challenge_params_timeout`, `handling_failed`), queued by an init script and polled per page, filed by page
  rather than by URL so a handling that navigates the page still ends the wait, since the remote browser
  never emits console events live. `hb_page_status` returns them; `hb_page_handle` posts the in-page
  `oxylabs-page-handle` message, waits up to 3 s for the runtime's `identifying` acknowledgement
  (`no-runtime` otherwise, and an immediate error on a tab without an http(s) document), then for the terminal
  status: `completed`, `already-handled` (nothing new on a page the handler had already handled; not an
  error), `not-found`, `error`, `timeout`.
- `hb_classify_page`: vendor-neutral verdicts `ok`, `navigation-error` (no response: `net::ERR_*`, browser
  error page; retry on the same identity), `oxylabs-network`, `challenge`, `hard-block`, `restricted-target`,
  `soft-block`, `target-error`, each with the next escalation step. Evidence names the signal, never the
  vendor. Child frames only (never the page's own URL), this page's states only, and once the page handler
  reports the page `open` a handled challenge is `ok` and interstitial text it found nothing in is
  `hard-block`. Also returns `page_handler_enabled` for the session and `bot_management_cookies` (a count).
- `hb_sessions_list`, `hb_session_stop`, `hb_recordings_list`, `hb_recording_url`, `hb_recording_delete`,
  `hb_profiles_list`, `hb_profile_delete`: dashboard API wrappers.
- `hb_reference` tool and `hb://reference/*` resources: `params`, `errors`, `challenges`.
- Credentials from `OXY_AB_USERNAME` / `OXY_AB_PASSWORD`, sent as a Basic auth header rather than in the URL
  (`HB_AUTH_MODE=url` puts them in the URL); password redaction on every tool result and error; service
  rejections such as `page handler is not enabled for this account` are explained with the next step.
- `prepare` script builds the package on install from a git source.

### Maintenance rule

`@playwright/mcp` pins an exact `playwright-core` build. Bump both `@playwright/mcp` and `playwright-core`
together (the `bridge` unit test fails when they drift).
