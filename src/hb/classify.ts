// Pure page classification: from the last main-frame response, title, visible text, frames, cookies, the last
// navigation error and the page handler's states it decides between ok, navigation error, Oxylabs network
// error, an access challenge the page handler acts on, a hard block it does not, restricted target, soft block
// or target error, and names the next step. Evidence strings name no vendor: they describe the signal.

export type Verdict =
  | 'ok'
  | 'navigation-error'
  | 'oxylabs-network'
  | 'challenge'
  | 'hard-block'
  | 'restricted-target'
  | 'soft-block'
  | 'target-error';

export interface PageFacts {
  url: string;
  status?: number;
  headers?: Record<string, string>;
  title?: string;
  bodySnippet?: string;
  frameUrls?: string[];
  cookieNames?: string[];
  /** The last failed navigation on the session (CDP 1337, net::ERR_*), when recent. */
  lastNavError?: string;
  /** The runtime's last page status on this document (identifying, closed, open, failed) and, for failed, why. */
  lastPageState?: { status: string; reason?: string };
  /** The page handler completed a challenge on this page earlier (a closed followed by an open). */
  challengeHandled?: boolean;
}

export interface Classification {
  verdict: Verdict;
  /** True when the page handler acts on this page (enable it, or wait for its state). */
  challenge_supported: boolean;
  retry: boolean;
  evidence: string[];
  next_step: string;
}

const NEXT: Record<Verdict, string> = {
  ok: 'Continue with the page.',
  'navigation-error':
    'The navigation failed before any response (network error, not a block): retry it once after a pause; if it repeats, check the URL, then reconnect. Do not change identity for this.',
  'oxylabs-network': 'Oxylabs network error: back off (1 s base, 60 s cap) and retry the navigation; reconnect if it repeats.',
  challenge:
    'Access challenge the page handler acts on: if page_handler is off, hb_disconnect and hb_connect again with page_handler=true, same geo/device; otherwise wait for the page state (hb_page_status, up to 90 s), or trigger hb_page_handle if the challenge appeared after load. A failed state means the handler could not complete it: fresh identity.',
  'hard-block':
    'Block page the page handler does not act on: hb_disconnect, then hb_connect as a fresh identity (new proxy_resi_ses_id / no or new o_profile), broader geo, then the new engine (p_src=oxybrowser with p_fp_tag=oxyfp_mac_optimized, desktop), then p_device=mobile, slower pacing, inspect via live_url. Never repeat the same request on this session.',
  'restricted-target': 'Restricted target category for this account (CDP 1337 Invalid target): do not retry; ask the account manager to unlock it.',
  'soft-block':
    'Possible soft block (login wall, empty content, /blocked redirect): verify via live_url or screenshot. If the content is only available after login, stop: only publicly available data is in scope. Otherwise fresh identity and slower pacing.',
  'target-error': 'The target answered with an error status without any block signature: check the URL, retry once after a pause, then treat as a block.',
};

/** Pure classification of a loaded page, ordered from most to least specific. */
export function classify(f: PageFacts): Classification {
  const evidence: string[] = [];
  const headers = lowerKeys(f.headers ?? {});
  const body = f.bodySnippet ?? '';
  const title = f.title ?? '';
  const frames = f.frameUrls ?? [];
  const cookies = new Set((f.cookieNames ?? []).map((c) => c.toLowerCase()));
  const status = f.status;

  const decide = (verdict: Verdict, challengeSupported: boolean, retry: boolean): Classification => ({
    verdict,
    challenge_supported: challengeSupported,
    retry,
    evidence,
    next_step: NEXT[verdict],
  });

  if (f.lastNavError && /\b1337\b|Invalid target/i.test(f.lastNavError)) {
    evidence.push(`navigation error: ${f.lastNavError}`);
    return decide('restricted-target', false, false);
  }
  const netError = f.lastNavError?.match(/net::ERR_[A-Z0-9_]+/)?.[0];
  if (netError || f.url.startsWith('chrome-error://')) {
    evidence.push(`navigation error: ${netError ?? 'browser error page'}`);
    return decide('navigation-error', false, true);
  }
  if (headers['x-error-description']) {
    evidence.push(`x-error-description: ${headers['x-error-description']}`);
    return decide('oxylabs-network', false, true);
  }
  if (status !== undefined) evidence.push(`status ${status}`);
  if (title) evidence.push(`title "${title.slice(0, 80)}"`);

  const blockFrame = frames.some((u) => /captcha-delivery\.com/i.test(u));
  if ((status === 403 && /DataAccess@datadome\.co/i.test(body)) || blockFrame || /captcha-delivery\.com/i.test(body) || (status === 403 && cookies.has('datadome'))) {
    if (blockFrame) evidence.push('bot-management frame present');
    if (cookies.has('datadome')) evidence.push('bot-management cookie present');
    if (/DataAccess@datadome\.co/i.test(body)) evidence.push('block page with a vendor contact address');
    return decide('hard-block', false, false);
  }

  const cfTitle = /Just a moment|Attention Required/i.test(title) || /Just a moment|Attention Required/i.test(body);
  const interstitial = (status === 403 || status === 503) && (cfTitle || headers['cf-mitigated'] === 'challenge');
  const challengeFrame = frames.some((u) => /challenges\.cloudflare\.com|hcaptcha\.com|recaptcha/i.test(u));
  const challengeText = /verify you are human/i.test(body) || cfTitle;
  if (interstitial || challengeFrame || challengeText) {
    if (interstitial) {
      if (headers['cf-mitigated']) evidence.push('challenge header present');
      if (cfTitle) evidence.push('verification interstitial text');
    } else if (challengeFrame) evidence.push('challenge frame present');
    else evidence.push('challenge text in body');
    if (f.lastPageState) evidence.push(`last page state: ${describeStatus(f.lastPageState)}`);
    // The page handler's word beats the signatures once it reports the page open: a challenge it handled
    // leaves its frame or script behind; a frame it found nothing in is not a challenge it acts on.
    if (f.lastPageState?.status === 'open') {
      if (f.challengeHandled) {
        evidence.push('challenge handled by the page handler');
        return decide('ok', false, false);
      }
      if (!interstitial && !challengeText) {
        evidence.push('page handler reports the page open: not a challenge it acts on');
        return decide('ok', false, false);
      }
      evidence.push('challenge text, but the page handler found nothing it acts on');
      return decide('hard-block', false, false);
    }
    return decide('challenge', true, false);
  }

  if (status === 403 && /Access Denied/i.test(body) && /Reference\s*#/i.test(body)) {
    evidence.push('"Access Denied" page with a reference id');
    if (cookies.has('_abck') || cookies.has('bm_sz')) evidence.push('bot-management cookies present');
    return decide('hard-block', false, false);
  }

  if (status !== undefined && status >= 400) {
    return decide('target-error', false, false);
  }

  let path = '';
  try {
    path = new URL(f.url).pathname.toLowerCase();
  } catch {
    // keep empty
  }
  const tiny = body.trim().length > 0 && body.trim().length < 500;
  const loginish = /\/(login|signin|sign-in|blocked|denied)\b/.test(path);
  if ((status === 200 || status === undefined) && (loginish || (tiny && f.bodySnippet !== undefined))) {
    if (loginish) evidence.push(`path ${path}`);
    if (tiny) evidence.push(`body only ${body.trim().length} chars`);
    return decide('soft-block', false, false);
  }

  if (f.lastPageState?.status === 'failed') {
    evidence.push(`last page state: ${describeStatus(f.lastPageState)}`);
    return decide('challenge', true, false);
  }
  return decide('ok', false, false);
}

function describeStatus(s: { status: string; reason?: string }): string {
  switch (s.status) {
    case 'identifying':
      return 'page being identified';
    case 'closed':
      return 'challenge found, being handled';
    case 'open':
      return 'page open (no challenge, or handled)';
    case 'failed':
      return `challenge not handled${s.reason ? ` (${s.reason})` : ''}`;
    default:
      return s.status;
  }
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}
