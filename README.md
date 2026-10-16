# oxylabs-ab-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents the full
[Playwright MCP](https://github.com/microsoft/playwright-mcp) tool set running inside an
**Oxylabs Agent Browser** session: remote Chrome in a managed browser environment with residential
proxies, geo-targeting, persistent profiles, session recording, live inspection and built-in challenge
handling. Nothing runs locally except this server.

`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_take_screenshot`, `browser_pdf_save`
and the rest work exactly as in Playwright MCP. On top, `hb_*` tools cover what only the HB service has.

## Install

Requires Node.js 20 or newer and an Oxylabs Agent Browser account (username and password from the
dashboard at `https://hb.oxylabs.io/dashboard`).

```sh
npm install -g oxylabs-ab-mcp        # or run with npx oxylabs-ab-mcp
```

From a checkout:

```sh
npm install && npm run build
node dist/cli.js --check     # prints the resolved settings, password masked
```

## Configure the MCP client

Claude Code:

```sh
claude mcp add hb -e OXY_AB_USERNAME=<username> -e OXY_AB_PASSWORD=<password> -- npx -y oxylabs-ab-mcp
```

From a checkout, for every project (user scope), pointing at this build:

```sh
make link OXY_AB_USERNAME=<username> OXY_AB_PASSWORD=<password> [HB_DEFAULT_PARAMS=p_cc=US]
make unlink
```

`.mcp.json` (Claude Code, Cursor and others use the same shape):

```json
{
  "mcpServers": {
    "hb": {
      "command": "npx",
      "args": ["-y", "oxylabs-ab-mcp", "--default-params", "p_cc=US"],
      "env": { "OXY_AB_USERNAME": "<username>", "OXY_AB_PASSWORD": "<password>" }
    }
  }
}
```

Cursor: open Settings, select MCP, add the configuration above, restart Cursor.

![Cursor Setup](resources/cursor_setup.gif)

Claude Desktop: open Settings, go to Developer, press Edit Config, add the configuration above to
`claude_desktop_config.json`, restart Claude Desktop.

![Claude Setup](resources/claude_setup.gif)

Streamable HTTP instead of stdio (Inspector, local agents; one client at a time):

```sh
OXY_AB_USERNAME=... OXY_AB_PASSWORD=... oxylabs-ab-mcp --port 8931      # serves http://127.0.0.1:8931/mcp
npx @modelcontextprotocol/inspector node dist/cli.js   # interactive check
```

## Settings

Precedence: CLI flag, then environment variable, then default.

| Setting | Flag / env | Default |
|---|---|---|
| Credentials | `OXY_AB_USERNAME`, `OXY_AB_PASSWORD` | required for anything that touches the service |
| Default parameters | `--default-params`, `HB_DEFAULT_PARAMS` (query string, e.g. `p_cc=US&p_device=mobile`) | none |
| Playwright capabilities | `--caps`, `HB_CAPS` (`vision,pdf,network,storage,testing,devtools,config`) | `vision,pdf` |
| Output directory | `--output-dir`, `HB_OUTPUT_DIR` (screenshots, PDFs, snapshot files) | `.playwright-mcp` in the working directory |
| Timeouts | `--timeout-action`, `--timeout-navigation`, `--connect-timeout` / `HB_CONNECT_TIMEOUT_MS` | 5 s, 60 s, 30 s |
| Connect retries | `HB_CONNECT_ATTEMPTS`, `HB_CONNECT_BUDGET_MS` | 6 attempts, 120 s |
| Max open sessions | `HB_MAX_SESSIONS` | 5 |
| Auth mode | `HB_AUTH_MODE` = `header` or `url` | `header` (Basic header, password never in the URL) |
| Playwright MCP config | `--config <file>`, `HB_PLAYWRIGHT_CONFIG` (JSON in Playwright MCP's format, merged under oxylabs-ab-mcp's forced keys) | none |
| Transport | `--port`, `--host` | stdio |

The service endpoint is fixed: `wss://hb.oxylabs.io` for the browser, `https://hb.oxylabs.io/dashboard`
for the dashboard API and `https://hb.oxylabs.io/novnc/` for the live view.

## How sessions work

1. `hb_connect` opens a session with the chosen parameters (country, device, named session, profile,
   recording, challenge handling; `HB_DEFAULT_PARAMS` supplies defaults) and returns its label. There is no implicit
   current session: every `browser_*` and `hb_*` tool takes that label as its `session` argument.
2. Several sessions can be open at once, one per identity: `hb_connect(label="de", p_cc="DE")` and
   `hb_connect(label="kr", p_cc="KR")` give two remote browsers in different countries. Each session has
   its own Playwright backend, so calls to different sessions run in parallel. `HB_MAX_SESSIONS`
   (default 5) caps the number of open sessions.
3. Sessions live at most 1 hour and hold a concurrency slot until closed: finish each with
   `browser_close(session=...)` or `hb_disconnect(session=...)`; `hb_disconnect(all=true)` closes
   everything. The server also closes all sessions on exit (SIGINT/SIGTERM, client disconnect).
4. Screenshots, PDFs and the snapshot written after navigation/clicks land in the output directory as
   files; `browser_snapshot` returns the accessibility tree inline.

## Tools

Playwright MCP tools (see its README): `browser_navigate`, `browser_navigate_back`, `browser_snapshot`,
`browser_click`, `browser_type`, `browser_fill_form`, `browser_hover`, `browser_drag`, `browser_select_option`,
`browser_press_key`, `browser_wait_for`, `browser_evaluate`, `browser_find`, `browser_handle_dialog`,
`browser_file_upload`, `browser_console_messages`, `browser_network_requests`, `browser_network_request`,
`browser_tabs`, `browser_take_screenshot`, `browser_pdf_save`, `browser_emulate_media`, `browser_close`,
the `vision` mouse tools, and any extra capability enabled with `--caps`.
Hidden on purpose: `browser_install` (nothing to install) and `browser_resize` (the service owns the viewport).

HB tools:

| Tool | Purpose |
|---|---|
| `hb_connect` | Open a session (optional `label`; reusing a label replaces that session) with public parameters: `p_cc`, `p_state`, `p_city`, `p_device`, `p_src` (`oxybrowser`), `p_fp_tag` (`oxyfp_win`, `oxyfp_mac`, `oxyfp_mac_optimized`, `oxyfp_v1_win`), `proxy`, `proxy_resi_ses_id`, `proxy_resi_ses_time`, `session_name`, `keep_alive`, `o_profile`, `o_profile_save`, `record`, `record_name`, `page_handler`; `replace_defaults` ignores `HB_DEFAULT_PARAMS`. Returns session id, live-view URL, effective parameters, expiry. |
| `hb_disconnect` | Close a session (`session`) or all of them (`all=true`). Named sessions stay resumable 10 min; profiles/recordings are written now. |
| `hb_session_info` | All open sessions (label, id, params, time left, tabs); with `session`, details of one: live URL, tabs with last main-frame status, page states (`oxylabs-page-status` messages), Oxylabs network errors. |
| `hb_classify_page` | Verdict for the current page: `ok`, `oxylabs-network` (retry), `challenge` (the page handler acts on it), `hard-block` (it does not: fresh identity), `restricted-target`, `soft-block`, `target-error`, with the next step. |
| `hb_page_handle` | Trigger challenge handling for a challenge that appeared after load and wait for the result. |
| `hb_page_status` | Page statuses from challenge handling (`oxylabs-page-status`): `identifying`, `closed` (challenge being handled), `open` (page usable), `failed` with reason. |
| `hb_sessions_list`, `hb_session_stop` | Live sessions of the account and their limit; stop a leaked one. |
| `hb_recordings_list`, `hb_recording_url`, `hb_recording_delete` | Session videos: list with limits, temporary playback URL, delete. |
| `hb_profiles_list`, `hb_profile_delete` | Stored profiles: list with limits, delete. |
| `hb_reference` | Parameter table, error catalogue and challenge handling guide (also as `hb://reference/*` resources). |

Typical flow: `hb_connect(label="us", p_cc="US")`, then `browser_navigate(session="us", ...)` and
`browser_snapshot(session="us")`; on a suspicious page `hb_classify_page(session="us")`; if it reports a
supported challenge, reconnect with `page_handler=true` or call `hb_page_handle`; if it reports a hard
block that a fresh identity does not clear, reconnect with `p_src="oxybrowser", p_fp_tag="oxyfp_mac_optimized"`;
finish with `browser_close(session="us")`.

## Security

- The password is sent as an `Authorization: Basic` header, never inside the websocket URL, and every
  known spelling of it (raw, percent-encoded, base64) is redacted from tool results and errors.
- Internal service parameters are rejected by name; only the documented public set is accepted.
- The HTTP transport binds `127.0.0.1` by default.

## Limitations

- Viewport and device metrics cannot be changed (the service owns the device configuration); use `p_device`.
- No extra browser contexts: everything runs in the session's default context, which is the one backed
  by the device configuration, proxy and profile.
- The HTTP mode serves one client at a time.
- If the 1-hour cap or a network drop ends the session, the next `browser_*` call opens a new one with the
  last parameters (including `o_profile_save` if it was set).
- `@playwright/mcp` pins a specific `playwright-core` build; both are pinned exactly here and must be
  bumped together.

## Development

```sh
npm test                         # build + offline unit tests
OXY_AB_USERNAME=... OXY_AB_PASSWORD=... npm run test:integration   # live smoke tests against the service
```

## Disclaimer

All information herein is provided on an "as is" basis and for informational purposes only. We make no
representation and disclaim all liability with respect to your use of any information contained on this
page. Before engaging in scraping activities of any kind you should consult your legal advisors and
carefully read the particular website's terms of service or receive a scraping license.

Playwright MCP is a third-party tool that is not owned or controlled by Oxylabs. Each third-party
provider is responsible for its own software and services; consequently Oxylabs will have no liability or
responsibility to you regarding those services. Please review carefully the third-party's policies and
practices or/and conduct due diligence before accessing or using any third-party services.
