// HbSession: one HB browser connection (one identity). Connects over CDP with backoff and Basic auth, fetches
// the gateway session id, tracks pages and their last main-frame responses, X-Error-Description network
// errors and page states (polled from the runtime's window messages), and closes the session; ensureContext() is the getter handed to Playwright MCP.

import { chromium, type Browser, type BrowserContext, type ConnectOverCDPOptions, type Page } from 'playwright-core';
import type { Settings } from '../settings.js';
import type { Redactor } from '../redact.js';
import { BackoffExhausted, withBackoff } from './backoff.js';
import { lastHandled, PageStateWatcher, type PageState } from './pageState.js';
import { explain, HbConnectError, isRetryable, parseHandshakeError } from './errors.js';
import { toQueryString, type HbParams } from './params.js';
import { getSessionId } from './sessionId.js';
import { buildAuthHeader, buildWsUrl, HB_ENDPOINT, liveViewUrl } from './url.js';

export const MAX_SESSION_MS = 60 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 5000;
const MAX_NET_ERRORS = 100;
/** How long a failed navigation stays relevant when no later response replaced it. */
const NAV_ERROR_TTL_MS = 60000;

export interface NavError {
  text: string;
  at: number;
}

/**
 * The navigation failure that still describes the page: the newest of the candidates, if it is more recent
 * than the page's last main response (a page that loaded since is not in error) and not older than the TTL.
 */
export function currentNavError(candidates: Array<NavError | undefined>, mainAt: number | undefined, now = Date.now()): string | undefined {
  let newest: NavError | undefined;
  for (const c of candidates) if (c && (!newest || c.at > newest.at)) newest = c;
  if (!newest || now - newest.at >= NAV_ERROR_TTL_MS) return undefined;
  if (mainAt !== undefined && newest.at <= mainAt) return undefined;
  return newest.text;
}

export interface MainResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  at: number;
}

export interface NetError {
  at: number;
  status: number;
  url: string;
  description: string;
}

export interface SessionState {
  browser: Browser;
  context: BrowserContext;
  sessionId: string;
  params: HbParams;
  connectedAt: number;
  liveUrl: string;
}

export interface ConnectInfo {
  label: string;
  session_id: string;
  live_url: string;
  effective_params: HbParams;
  connect_ms: number;
  attempts: number;
  expires_at: string;
  notes: string[];
}

export interface DisconnectInfo {
  label: string;
  session_id?: string;
  session_name?: string;
  profile_saved?: string;
  recorded?: boolean;
}

export type Logger = (message: string) => void;
export type ConnectOverCDP = (url: string, options: ConnectOverCDPOptions) => Promise<Browser>;

export function requireCredentials(settings: Settings): { username: string; password: string } {
  const { username, password } = settings;
  if (!username || !password) {
    throw new Error(
      'Oxylabs Agent Browser credentials are not configured. Set OXY_AB_USERNAME and OXY_AB_PASSWORD in the MCP server environment.',
    );
  }
  return { username, password };
}

/** One HB browser connection (one identity: geo, device configuration, profile) and everything observed on it. */
export class HbSession {
  readonly pageState = new PageStateWatcher();
  readonly netErrors: NetError[] = [];
  /** The last failed navigation reported by a forwarded browser_navigate (e.g. CDP 1337 Invalid target). */
  lastNavError?: NavError;

  private state?: SessionState;
  private connecting?: Promise<SessionState>;
  private lastAttempts = 0;
  private readonly mainResponses = new WeakMap<Page, MainResponse>();
  /** Per page: the last main-frame navigation request that got no response (net::ERR_*). */
  private readonly navFailures = new WeakMap<Page, NavError>();
  private lastActivePage?: Page;

  constructor(
    readonly label: string,
    readonly params: HbParams,
    private readonly settings: Settings,
    private readonly redactor: Redactor,
    private readonly log: Logger = () => undefined,
    private readonly connectOverCDP: ConnectOverCDP = (url, options) => chromium.connectOverCDP(url, options),
  ) {}

  isConnected(): boolean {
    return this.state !== undefined && this.state.browser.isConnected();
  }

  current(): SessionState | undefined {
    if (this.state && !this.state.browser.isConnected()) this.state = undefined;
    return this.state;
  }

  /** contextGetter for this session's Playwright MCP backend: reuse the live context or (re)connect. */
  async ensureContext(): Promise<BrowserContext> {
    const live = this.current();
    if (live) return live.context;
    return (await this.connectState()).context;
  }

  async connect(): Promise<ConnectInfo> {
    const startedAt = Date.now();
    const state = await this.connectState();
    const p = this.params;
    const notes: string[] = [];
    if (p.page_handler === undefined) notes.push('page_handler not set: the account setting applies (handling may be on); pass page_handler=false or true explicitly.');
    if (p.session_name) notes.push(`Named session "${p.session_name}": resumable for 10 min after disconnect by reconnecting with the same session_name.`);
    if (p.o_profile_save) notes.push(`Profile "${p.o_profile}" is write-locked and will be saved when this session ends.`);
    if (p.record) notes.push('Recording is on; the video appears in hb_recordings_list after the session ends.');
    notes.push('Sessions live at most 1 hour. Use the default context only; never set the viewport.');
    return {
      label: this.label,
      session_id: state.sessionId,
      live_url: state.liveUrl,
      effective_params: p,
      connect_ms: Date.now() - startedAt,
      attempts: this.lastAttempts,
      expires_at: new Date(state.connectedAt + MAX_SESSION_MS).toISOString(),
      notes,
    };
  }

  async disconnect(reason: string): Promise<DisconnectInfo> {
    const s = this.state;
    this.state = undefined;
    this.lastActivePage = undefined;
    if (!s) return { label: this.label };
    this.log(`[${this.label}] closing HB session ${s.sessionId} (${reason})`);
    await Promise.race([s.browser.close(), new Promise<void>((r) => setTimeout(r, CLOSE_TIMEOUT_MS))]).catch(() => undefined);
    return {
      label: this.label,
      session_id: s.sessionId,
      session_name: s.params.session_name,
      profile_saved: s.params.o_profile_save ? s.params.o_profile : undefined,
      recorded: s.params.record === true,
    };
  }

  pages(): Page[] {
    const s = this.current();
    return s ? s.context.pages() : [];
  }

  /** The page hb_* tools act on: explicit tab index, else the most recently navigated page, else the last page. */
  page(tabIndex?: number): Page {
    const pages = this.pages();
    if (!pages.length) throw new Error(`No open page in HB session "${this.label}". Call browser_navigate (or browser_tabs action=new) first.`);
    if (tabIndex !== undefined) {
      const p = pages[tabIndex];
      if (!p) throw new Error(`tab_index ${tabIndex} out of range (open tabs: ${pages.length})`);
      return p;
    }
    if (this.lastActivePage && !this.lastActivePage.isClosed() && pages.includes(this.lastActivePage)) return this.lastActivePage;
    return pages[pages.length - 1];
  }

  mainResponse(page: Page): MainResponse | undefined {
    return this.mainResponses.get(page);
  }

  /** The navigation failure that still describes the page, if any (see `currentNavError`). */
  navError(page: Page): string | undefined {
    return currentNavError([this.navFailures.get(page), this.lastNavError], this.mainResponses.get(page)?.at);
  }

  /**
   * The `open` that ended a challenge the page handler completed on the page's current document: the
   * handling usually navigates the page (the `closed` is on the challenge document, the `open` on the one it
   * led to), so the pairing is read from the page's whole history and only the `open` has to be as recent
   * as the current document's main response. Undefined once the tab has moved on to another page.
   */
  challengeHandled(page: Page): PageState | undefined {
    const handled = lastHandled(this.pageState.forPage(this.pageState.pageIdOf(page)));
    const main = this.mainResponses.get(page);
    return handled && main && handled.at >= main.at ? handled : undefined;
  }

  /** Remember a failed navigation (e.g. CDP 1337 Invalid target) reported by a forwarded browser_navigate. */
  noteNavigationResult(result: { isError?: boolean; content?: Array<{ type: string; text?: string }> }): void {
    if (!result.isError) return;
    const text = (result.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('\n');
    if (text) this.lastNavError = { text: text.slice(0, 500), at: Date.now() };
  }

  summary(): Record<string, unknown> {
    const s = this.current();
    const now = Date.now();
    return {
      label: this.label,
      connected: !!s,
      session_id: s?.sessionId,
      live_url: s?.liveUrl,
      params: this.params,
      remaining_s: s ? Math.max(0, Math.round((s.connectedAt + MAX_SESSION_MS - now) / 1000)) : undefined,
      tabs: s ? s.context.pages().length : 0,
    };
  }

  private connectState(): Promise<SessionState> {
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<SessionState> {
    const creds = requireCredentials(this.settings);
    const query = toQueryString(this.params);
    const url = buildWsUrl(query, this.settings.authMode === 'url' ? creds : undefined);
    const headers = this.settings.authMode === 'header' ? { Authorization: buildAuthHeader(creds.username, creds.password) } : undefined;
    this.log(`[${this.label}] connecting to ${HB_ENDPOINT} with ${query || '(no params)'}`);

    let attempts = 0;
    let browser: Browser;
    try {
      browser = await withBackoff(
        async (attempt) => {
          attempts = attempt + 1;
          return this.connectOverCDP(url, { timeout: this.settings.connect.timeoutMs, headers });
        },
        {
          attempts: this.settings.connect.attempts,
          budgetMs: this.settings.connect.budgetMs,
          isRetryable: (err) => isRetryable(parseHandshakeError(err)),
          onRetry: (err, attempt, delay) =>
            this.log(`[${this.label}] connect attempt ${attempt} failed: ${this.redactor.error(err).split('\n')[0]}; retrying in ${Math.round(delay)} ms`),
        },
      );
    } catch (err) {
      const cause = err instanceof BackoffExhausted ? err.cause : err;
      const info = parseHandshakeError(cause);
      const detail = [info.status ? `${info.status} ${info.statusText ?? ''}`.trim() : '', info.body ?? '', !info.status && !info.body ? info.message.split('\n')[0] : '']
        .filter(Boolean)
        .join(': ');
      const fix = explain(info);
      const budget = err instanceof BackoffExhausted && err.budgetHit ? ' (connect time budget exhausted)' : '';
      const message = this.redactor.text(
        `Could not connect to the Oxylabs Agent Browser after ${attempts} attempt(s)${budget}: ${detail}${fix ? `. Fix: ${fix}` : ''}`,
      );
      throw new HbConnectError(message, info, attempts);
    }
    this.lastAttempts = attempts;

    try {
      const context = browser.contexts()[0];
      if (!context) throw new Error('the gateway returned no default browser context');
      await this.pageState.install(context);
      const page = context.pages()[0] ?? (await context.newPage());
      const sessionId = await getSessionId(context, page);
      const state: SessionState = { browser, context, sessionId, params: this.params, connectedAt: Date.now(), liveUrl: liveViewUrl(sessionId) };
      this.attach(state);
      this.state = state;
      this.log(`[${this.label}] HB session ${sessionId} ready (${state.liveUrl})`);
      return state;
    } catch (err) {
      await browser.close().catch(() => undefined);
      throw new Error(this.redactor.text(`connected but session setup failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private attach(state: SessionState): void {
    const { browser, context } = state;
    for (const p of context.pages()) this.attachPage(p);
    context.on('page', (p) => this.attachPage(p));
    browser.once('disconnected', () => {
      if (this.state?.browser === browser) {
        this.log(`[${this.label}] HB session ${state.sessionId} disconnected`);
        this.state = undefined;
        this.lastActivePage = undefined;
      }
    });
  }

  private attachPage(page: Page): void {
    this.lastActivePage = page;
    this.pageState.watch(page);
    page.on('response', (resp) => {
      const req = resp.request();
      const headers = resp.headers();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        this.mainResponses.set(page, { url: resp.url(), status: resp.status(), headers, at: Date.now() });
        this.lastActivePage = page;
      }
      const description = headers['x-error-description'];
      if (description) {
        this.netErrors.push({ at: Date.now(), status: resp.status(), url: resp.url(), description });
        if (this.netErrors.length > MAX_NET_ERRORS) this.netErrors.splice(0, this.netErrors.length - MAX_NET_ERRORS);
      }
    });
    page.on('requestfailed', (req) => {
      // A main-frame navigation that got no response (net::ERR_*): the page shows a browser error page and
      // the previous document's response no longer describes it. A load cut short by another navigation
      // (a redirect by script, a challenge's token hop) fails with ERR_ABORTED and is not an error.
      if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) return;
      const text = req.failure()?.errorText ?? 'navigation failed';
      if (/ERR_ABORTED/.test(text)) return;
      this.navFailures.set(page, { text, at: Date.now() });
      this.mainResponses.delete(page);
    });
    page.on('close', () => {
      if (this.lastActivePage === page) this.lastActivePage = undefined;
    });
  }
}
