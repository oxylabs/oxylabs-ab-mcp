// Understands HB handshake failures: parses Playwright's "WebSocket error: <url> <status> <text>\n<body>"
// messages, decides which errors are retryable, and maps known bodies and CDP_* codes to the fix a user
// should apply.

export interface HandshakeError {
  message: string;
  status?: number;
  statusText?: string;
  body?: string;
  code?: string;
}

const RETRYABLE_CODES = /CDP_SESSION_IN_USE|CDP_NO_BROWSERS_AVAILABLE|CDP_BROWSER_OVERWORKED|CDP_BAD_PROXY|CDP_GENERAL_ERROR/;
const TRANSIENT_TEXT = /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|EPIPE|network error/i;

/** Parse Playwright's `WebSocket error: <url> <status> <text>\n<body>` (and similar) messages. */
export function parseHandshakeError(err: unknown): HandshakeError {
  const message = err instanceof Error ? err.message : String(err);
  const out: HandshakeError = { message };
  const m = /\s(\d{3}) ([A-Z][A-Za-z' -]*?)(?:\n([\s\S]*))?$/.exec(message);
  if (m) {
    out.status = Number(m[1]);
    out.statusText = m[2].trim();
    if (m[3] !== undefined) out.body = m[3].trim();
  } else {
    const p = /Unexpected server response: (\d{3})/.exec(message);
    if (p) out.status = Number(p[1]);
  }
  const code = /CDP_[A-Z0-9_]+/.exec(message);
  if (code) out.code = code[0];
  return out;
}

export function isRetryable(e: HandshakeError): boolean {
  if (e.status !== undefined) {
    if (e.status === 429 || e.status >= 500) return true;
    if (e.status >= 400) return false;
  }
  if (e.code && RETRYABLE_CODES.test(e.code)) return true;
  if (/\b1337\b/.test(e.message)) return false;
  return TRANSIENT_TEXT.test(e.message);
}

const FIXES: Array<[RegExp, string]> = [
  [/missing auth header/, 'no Authorization header reached the gateway; oxylabs-ab-mcp always sends one, so a proxy in between is stripping it'],
  [/invalid credentials/, 'check OXY_HB_USERNAME / OXY_HB_PASSWORD (full username as shown in the dashboard, raw password)'],
  [/keep_alive requires session_name/, 'add session_name or drop keep_alive'],
  [/session_name must be/, 'session_name is 3-36 characters of [A-Za-z0-9-]'],
  [/unsupported proxy type/, 'use proxy=resi or proxy=dc'],
  [/is not enabled for this user/, 'drop the proxy parameter (defaults to resi) or ask support to enable it'],
  [/proxy=dc does not support/, 'remove geo and sticky-session parameters or switch to proxy=resi'],
  [/invalid p_cc/, 'use a two-letter ISO-3166 country code'],
  [/proxy_resi_ses_id must be/, 'sticky id is 3-36 characters of [A-Za-z0-9_] starting with a letter or digit'],
  [/proxy_resi_ses_time must be/, 'sticky time is 1-1440 minutes'],
  [/o_profile must contain/, 'profile name is 3-36 characters of [A-Za-z0-9_-] starting with a letter or digit'],
  [/o_profile_save requires/, 'add o_profile'],
  [/record_name requires/, 'add record=true'],
  [/browser profile feature is not enabled/, 'remove o_profile or ask support to enable profiles'],
  [/profile limit reached/, 'delete unused profiles with hb_profiles_list / hb_profile_delete, or reuse a name'],
  [/recordings are not enabled/, 'remove record'],
  [/recording limit reached/, 'delete old recordings with hb_recordings_list / hb_recording_delete'],
  [/profile is already in use/, 'a run with o_profile_save=true still holds this profile; wait 30 s+ or use o_profile without o_profile_save'],
  [/page handler is not enabled/i, 'drop page_handler or ask support to enable the page handler'],
  [/CDP_SESSION_RATE_LIMIT_REACHED/, 'more than 10 new sessions per second; space launches out'],
  [/CDP_MAX_CONCURRENT_SESSIONS_REACHED/, 'concurrency cap hit; unclosed sessions count for ~20 s (10 min when named). Check hb_sessions_list / hb_session_stop'],
  [/CDP_MAX_PERSISTENT_SESSIONS_REACHED/, 'cap of named sessions (default 5); reuse a name or let old ones expire'],
  [/CDP_SESSION_IN_USE/, 'the named session still has a live connection; close it first, then retry'],
  [/CDP_SESSION_NOT_FOUND/, 'the named session expired (10 min); start a new one'],
  [/max queue sessions reached/, 'too many connections waiting for capacity; lower parallelism and back off'],
  [/queue timeout/, 'waited about a minute for capacity; back off 30-60 s and retry'],
  [/CDP_BAD_PROXY/, 'proxy could not be established for the requested geo / sticky id; rotate proxy_resi_ses_id or drop p_city'],
  [/CDP_NO_BROWSERS_AVAILABLE|CDP_BROWSER_OVERWORKED/, 'no browser capacity right now; retry with backoff'],
  [/CDP_GENERAL_ERROR/, 'internal setup failure; retry with backoff, contact support if it persists'],
  [/Invalid target/, 'the host is restricted for this account; do not retry, ask your account manager to unlock the category'],
];

export function explain(e: HandshakeError): string {
  const haystack = `${e.body ?? ''}\n${e.message}`;
  for (const [re, fix] of FIXES) {
    if (re.test(haystack)) return fix;
  }
  if (e.status === 401) return 'authentication failed; fix credentials, never retry unchanged';
  if (e.status === 400 || e.status === 403 || e.status === 409) return 'the request is wrong; fix the named parameter, never retry unchanged';
  if (e.status === 429) return 'rate or concurrency limit; back off and retry';
  if (e.status !== undefined && e.status >= 500) return 'service-side error; back off and retry';
  return '';
}

export class HbConnectError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;
  readonly attempts: number;

  constructor(message: string, info: HandshakeError, attempts: number) {
    super(message);
    this.name = 'HbConnectError';
    this.status = info.status;
    this.code = info.code;
    this.retryable = isRetryable(info);
    this.attempts = attempts;
  }
}
