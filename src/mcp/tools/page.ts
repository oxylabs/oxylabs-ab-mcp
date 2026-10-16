// hb_page_handle (trigger built-in challenge handling on a session's page and wait for the outcome) and
// hb_page_status (list the page statuses the challenge handling runtime reported on a session).

import { z } from 'zod';
import type { PageState } from '../../hb/pageState.js';
import { defineTool, SESSION_ARG_DESCRIPTION, textResult } from './index.js';

const ESCALATION =
  'On error: do not retry on this session. hb_disconnect, back off (10 s, doubling), hb_connect as a fresh identity (new proxy_resi_ses_id, new or no o_profile) with page_handler=true, at most 2 more attempts, then stop and report.';

/** The runtime acknowledges a handle request with `identifying` at once; no acknowledgement means no runtime on the page. */
const ACK_MS = 3000;

export type HandleOutcome = 'completed' | 'already-handled' | 'not-found' | 'error' | 'timeout' | 'no-runtime';

/**
 * The outcome of a handle round. `round` holds the page's states since the trigger, `ev` the terminal state
 * the round ended with (undefined on timeout), `handled` the `open` of a challenge the handler completed on
 * the current document before the call (`HbSession.challengeHandled`). A round that found no challenge
 * (`open` without `closed`) on such a document is not a failure: the page is usable, and the handling just
 * happened before the call.
 */
export function handleOutcome(round: readonly PageState[], ev: PageState | undefined, handled: PageState | undefined): HandleOutcome {
  if (!ev) return 'timeout';
  if (ev.status === 'failed') return 'error';
  if (round.some((e) => e.status === 'closed')) return 'completed';
  return handled ? 'already-handled' : 'not-found';
}

export const hbPageHandle = defineTool({
  name: 'hb_page_handle',
  description:
    'Ask the page handler to identify the current tab again and complete the access challenge it finds (one that appeared after page load, after a click or form submit), then wait for the page state. Requires the session to have the page handler enabled (page_handler=true on hb_connect; absent, the account setting applies, so pass it explicitly). Challenges present at page load are handled automatically; use hb_page_status to see those. For a block page the handler does not act on, hb_classify_page says so: fresh identity instead.',
  input: z.object({
    session: z.string().min(1).describe(SESSION_ARG_DESCRIPTION),
    tab_index: z.number().int().min(0).optional().describe('Tab to act on (browser_tabs index). Default: the most recently navigated tab.'),
    timeout_ms: z.number().int().min(1000).max(180000).optional().describe('How long to wait for the page state (default 90000; a widget challenge typically takes 30-45 s).'),
  }),
  annotations: { title: 'Handle challenge', openWorldHint: true },
  handler: async (args, ctx, signal) => {
    const session = ctx.hub.get(args.session).session;
    const s = session.current();
    if (!s) return textResult(`HB session "${session.label}" is not connected; navigate to the page first.`, undefined, true);
    if (s.params.page_handler !== true) {
      return textResult(
        'challenge handling is off on this session (page_handler not set or false). Reconnect with hb_connect(page_handler=true) and the same geo/device, then load the page again.',
        undefined,
        true,
      );
    }
    const page = session.page(args.tab_index);
    if (!/^https?:/i.test(page.url())) {
      return textResult(`No page loaded in this tab (${page.url() || 'about:blank'}): browser_navigate to the target first, then call hb_page_handle.`, undefined, true);
    }
    const pageId = session.pageState.pageIdOf(page);
    const timeout = args.timeout_ms ?? 90000;
    // Statuses posted before the call but not polled yet belong to the history, not to this round.
    await session.pageState.drain(page);
    const startedAt = Date.now();
    // The runtime acknowledges a handle request with `identifying`, reports `closed` when it finds a
    // challenge, and ends with a terminal status: open or failed. Both waits are armed before the
    // trigger so the acknowledgement cannot slip past; no acknowledgement ends the wait early.
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const ack = session.pageState.waitFor(ACK_MS, { pageId, transient: true, signal: abort.signal });
    const waiter = session.pageState.waitFor(timeout, { pageId, signal: abort.signal });
    let ev: PageState | undefined;
    let acknowledged = false;
    try {
      await session.pageState.trigger(page);
      acknowledged = (await ack) !== undefined;
      if (acknowledged) ev = await waiter;
    } finally {
      abort.abort();
      signal?.removeEventListener('abort', onAbort);
    }
    const round = session.pageState.forPage(pageId).filter((e) => e.at >= startedAt);
    const handled = session.challengeHandled(page);
    const outcome: HandleOutcome = acknowledged ? handleOutcome(round, ev, handled) : 'no-runtime';
    const data = {
      session: session.label,
      outcome,
      duration_ms: Date.now() - startedAt,
      page_url: page.url(),
      reason: ev?.reason,
      handled_at: outcome === 'already-handled' && handled ? new Date(handled.at).toISOString() : undefined,
      handled_url: outcome === 'already-handled' ? handled?.pageUrl : undefined,
      events: round.map((e) => ({ at: new Date(e.at).toISOString(), status: e.status, reason: e.reason, page_url: e.pageUrl })),
    };
    switch (outcome) {
      case 'completed':
        return textResult('challenge handling completed. Take a fresh browser_snapshot; the page may have navigated.', data);
      case 'already-handled':
        return textResult(
          `No new challenge: the page handler had already completed one on this document at ${data.handled_at} (${data.handled_url}), and this round found nothing more (open without closed). The page is usable; take a fresh browser_snapshot.`,
          data,
        );
      case 'error':
        return textResult(`challenge handling reported an error${ev?.reason ? ` (${ev.reason})` : ''}. ${ESCALATION}`, data, true);
      case 'not-found':
        return textResult(
          'The runtime found no supported challenge on the page (oxylabs-page-status went open without closed, and none was handled on this document before). Check hb_classify_page and the live view; if the challenge never rendered, resource blocking is the usual cause.',
          data,
          true,
        );
      case 'no-runtime':
        return textResult(
          `The page handler did not acknowledge the request within ${ACK_MS} ms: the runtime is not loaded on this page. It runs on http(s) documents only, not on browser error pages or downloads; reload the page (browser_navigate) and check hb_page_status for an identifying state before calling again.`,
          data,
          true,
        );
      default:
        return textResult(
          `No terminal page status within ${timeout} ms. Challenge handling may still be running (status closed); check hb_page_status, hb_classify_page and the live view before retrying.`,
          data,
          true,
        );
    }
  },
});

export const hbPageStatus = defineTool({
  name: 'hb_page_status',
  description:
    'List the page statuses the challenge handling runtime reported in this session (oxylabs-page-status messages), newest last. status: identifying (page being checked), closed (challenge found, being handled), open (page usable: nothing found, or the challenge was handled), failed (with reason; always after a closed).',
  input: z.object({
    session: z.string().min(1).describe(SESSION_ARG_DESCRIPTION),
    limit: z.number().int().min(1).max(200).optional().describe('Maximum events to return (default 20).'),
  }),
  annotations: { title: 'Page status', readOnlyHint: true },
  handler: async (args, ctx) => {
    const events = ctx.hub.get(args.session).session.pageState.recent(args.limit ?? 20).map((e) => ({ at: new Date(e.at).toISOString(), status: e.status, reason: e.reason, page_url: e.pageUrl, text: e.text }));
    const last = events[events.length - 1];
    const describe = (e: (typeof events)[number]) => (e.status === 'failed' ? `failed${e.reason ? ` (${e.reason})` : ''}` : e.status);
    return textResult(events.length ? `${events.length} status(es); last: ${describe(last)} on ${last.page_url}` : 'No page status seen in this session (challenge handling off, or no page identified yet).', events);
  },
});
