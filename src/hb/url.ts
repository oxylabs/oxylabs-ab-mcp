// Fixed service endpoints (browser, dashboard, live view) and URL/auth helpers: websocket URL built by
// concatenation, Basic header in the URL-safe base64 form the gateway decodes, live-view (noVNC) URL.

/** The Oxylabs Agent Browser is a hosted service with one public endpoint; these are not configurable. */
export const HB_ENDPOINT = 'wss://hb.oxylabs.io';
export const HB_DASHBOARD_URL = 'https://hb.oxylabs.io/dashboard';
export const HB_VNC_URL = 'https://hb.oxylabs.io';

/** `wss://hb.oxylabs.io/?a=b` built by concatenation: nothing here re-encodes anything. */
export function buildWsUrl(query: string, userinfo?: { username: string; password: string }): string {
  const withAuth = userinfo ? HB_ENDPOINT.replace(/^(wss:\/\/)/, `$1${userinfo.username}:${userinfo.password}@`) : HB_ENDPOINT;
  return `${withAuth}/${query ? `?${query}` : ''}`;
}

/**
 * The gateway decodes Basic credentials with the URL-safe base64 alphabet, so a token that standard base64
 * would spell with `+` or `/` must be sent as base64url; padding is kept either way.
 */
export function buildAuthHeader(username: string, password: string): string {
  const std = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  const token = /[+/]/.test(std) ? std.replace(/\+/g, '-').replace(/\//g, '_') : std;
  return `Basic ${token}`;
}

export function liveViewUrl(sessionId: string): string {
  return `${HB_VNC_URL}/novnc/?id=${encodeURIComponent(sessionId)}`;
}
