// Page state observation: collects the `oxylabs-page-status` messages the in-browser runtime posts to every
// page's window (identifying, closed, open, failed), keeps a per-session buffer of them keyed by page, lets
// callers wait for the next terminal one on a page, and triggers handling of a late challenge through the
// page's `oxylabs-page-handle` postMessage.
//
// The runtime also logs each status as a console line, but the remote browser never emits console events
// live (they are only replayed when a client enables Runtime on an already-open page), and it exposes no CDP
// bindings either. So an init script queues the window messages on each document and `watch` drains the
// queue by polling. Messages posted in the last poll interval before a navigation away from a document are
// lost; the interval bounds that window.

import type { BrowserContext, Page } from 'playwright-core';

/**
 * The runtime's page states. `identifying` (page load or a handle request acknowledged) and `closed` (a
 * challenge was found and is being handled) are transient; `open` (the page is usable: nothing found, or
 * the challenge was handled) and `failed` are terminal. A `failed` is always preceded by a `closed`.
 */
export type PageStatusState = 'identifying' | 'closed' | 'open' | 'failed';

export const PAGE_STATES: readonly PageStatusState[] = ['identifying', 'closed', 'open', 'failed'];
export const TERMINAL_STATES: readonly PageStatusState[] = ['open', 'failed'];

/** One page status from the runtime. */
export interface PageState {
  at: number;
  /** The page (tab) it was observed on; stable for the page's lifetime, across its navigations. */
  pageId: number;
  pageUrl: string;
  /** The status as the runtime's console line would print it: `oxylabs-page-status - {json}`. */
  text: string;
  status: PageStatusState;
  /** Why the challenge was not handled; only with `failed`. */
  reason?: string;
}

export type ParsedPageState = Pick<PageState, 'status' | 'reason'>;

export const RUNTIME_SOURCE = 'oxylabs-runtime';
export const PAGE_STATUS = 'oxylabs-page-status';
export const PAGE_HANDLE = 'oxylabs-page-handle';

/** Window property holding the queued statuses of the current document. */
export const STATUS_QUEUE = '__oxyPageStatuses';
export const POLL_MS = 500;
const MAX_EVENTS = 200;

interface QueueNames {
  queue: string;
  source: string;
  type: string;
}

export function isTerminal(status: PageStatusState): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * The `open` that ended the last handled challenge in `events` (a `closed` followed, possibly after an
 * `identifying` of the navigation the token caused, by an `open`), or undefined when none was handled.
 */
export function lastHandled(events: readonly PageState[]): PageState | undefined {
  let closed = false;
  let handled: PageState | undefined;
  for (const ev of events) {
    if (ev.status === 'closed') closed = true;
    else if (ev.status === 'failed') closed = false;
    else if (ev.status === 'open' && closed) {
      handled = ev;
      closed = false;
    }
  }
  return handled;
}

/** Runs at document start in every frame: queues the runtime's page status messages on the window. */
function queueStatusMessages(names: QueueNames): void {
  const w = globalThis as unknown as Record<string, unknown[]> & {
    addEventListener: (type: string, listener: (e: { data?: unknown }) => void) => void;
  };
  const queue: unknown[] = [];
  w[names.queue] = queue;
  w.addEventListener('message', (e) => {
    const d = e.data as { source?: unknown; type?: unknown; status?: unknown; error?: unknown } | null;
    if (d && typeof d === 'object' && d.source === names.source && d.type === names.type) {
      queue.push({ status: d.status, error: d.error });
    }
  });
}

/** Runs in the page: hands over everything queued since the last poll. */
function drainQueue(queue: string): unknown[] {
  const list = (globalThis as unknown as Record<string, unknown>)[queue];
  return Array.isArray(list) ? list.splice(0) : [];
}

/** Collects the page states of a session and lets callers wait for the next one. */
export class PageStateWatcher {
  private readonly events: PageState[] = [];
  private readonly waiters = new Set<(ev: PageState) => void>();
  private readonly pageIds = new WeakMap<Page, number>();
  private nextPageId = 1;

  /** Reads a queued message; undefined for anything that is not a known page status. */
  static parse(data: unknown): ParsedPageState | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const { status, error } = data as { status?: unknown; error?: unknown };
    if (typeof status !== 'string' || !(PAGE_STATES as readonly string[]).includes(status)) return undefined;
    return {
      status: status as PageStatusState,
      reason: typeof error === 'string' && error ? error : undefined,
    };
  }

  /** Install the queueing init script; must run before the pages of the context navigate. */
  async install(context: BrowserContext): Promise<void> {
    await context.addInitScript(queueStatusMessages, { queue: STATUS_QUEUE, source: RUNTIME_SOURCE, type: PAGE_STATUS });
  }

  /** The id this watcher files a page's states under. */
  pageIdOf(page: Page): number {
    let id = this.pageIds.get(page);
    if (id === undefined) {
      id = this.nextPageId++;
      this.pageIds.set(page, id);
    }
    return id;
  }

  /** Poll the page's queue until the page closes. */
  watch(page: Page): void {
    const timer = setInterval(() => void this.drain(page), POLL_MS);
    timer.unref();
    page.on('close', () => clearInterval(timer));
  }

  /** One poll of the page's main document; a document that is navigating or gone yields nothing. */
  async drain(page: Page): Promise<void> {
    let batch: unknown[];
    try {
      batch = await page.mainFrame().evaluate(drainQueue, STATUS_QUEUE);
    } catch {
      return;
    }
    const pageId = this.pageIdOf(page);
    for (const item of batch) {
      const parsed = PageStateWatcher.parse(item);
      if (!parsed) continue;
      const text = `${PAGE_STATUS} - ${JSON.stringify(parsed.reason ? { status: parsed.status, error: parsed.reason } : { status: parsed.status })}`;
      this.record({ at: Date.now(), pageId, ...parsed, pageUrl: safeUrl(page), text });
    }
  }

  record(ev: PageState): void {
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const w of this.waiters) w(ev);
  }

  recent(limit = 10): PageState[] {
    return this.events.slice(-limit);
  }

  /** The states observed on one page, oldest first. */
  forPage(pageId: number, limit = MAX_EVENTS): PageState[] {
    return this.events.filter((e) => e.pageId === pageId).slice(-limit);
  }

  last(): PageState | undefined {
    return this.events[this.events.length - 1];
  }

  clear(): void {
    this.events.length = 0;
  }

  /**
   * Resolve with the next terminal status (open or failed; optionally only on the page `pageId`), or
   * undefined on timeout or abort. `transient: true` also resolves on identifying/closed.
   */
  waitFor(timeoutMs: number, opts: { pageId?: number; signal?: AbortSignal; transient?: boolean } = {}): Promise<PageState | undefined> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (ev: PageState | undefined) => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(listener);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(ev);
      };
      const listener = (ev: PageState) => {
        if (opts.pageId !== undefined && ev.pageId !== opts.pageId) return;
        if (!opts.transient && !isTerminal(ev.status)) return;
        done(ev);
      };
      const onAbort = () => done(undefined);
      if (opts.signal?.aborted) {
        resolve(undefined);
        return;
      }
      this.waiters.add(listener);
      timer = setTimeout(() => done(undefined), timeoutMs);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Ask the in-page runtime to identify the page again and handle what it finds. It acknowledges with
   * `identifying` at once and reports a terminal status when done.
   */
  async trigger(page: Page): Promise<void> {
    await page.evaluate((handle) => {
      const w = globalThis as unknown as { postMessage: (message: unknown, targetOrigin: string) => void };
      w.postMessage({ type: handle }, '*');
    }, PAGE_HANDLE);
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}
