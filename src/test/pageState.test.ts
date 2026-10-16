// PageStateWatcher: the page status message parser, polling, waiting, and the in-page trigger.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { lastHandled, PageStateWatcher, PAGE_HANDLE, STATUS_QUEUE, type PageState } from '../hb/pageState.js';

/** A page whose main document holds a status queue; `evaluate` on the page records its argument. */
function fakePage(url = 'https://site.test/'): { page: Page; queue: unknown[]; evaluated: unknown[]; fail: { now: boolean } } {
  const queue: unknown[] = [];
  const evaluated: unknown[] = [];
  const fail = { now: false };
  const frame = {
    evaluate: async (fn: (q: string) => unknown[], arg: string) => {
      if (fail.now) throw new Error('Execution context was destroyed');
      assert.equal(arg, STATUS_QUEUE);
      const w = globalThis as unknown as Record<string, unknown>;
      w[arg] = queue;
      try {
        return fn(arg);
      } finally {
        delete w[arg];
      }
    },
  };
  const page = {
    url: () => url,
    mainFrame: () => frame,
    evaluate: async (_fn: unknown, arg: unknown) => {
      evaluated.push(arg);
      return undefined;
    },
  } as unknown as Page;
  return { page, queue, evaluated, fail };
}

test('parse reads a page status message and nothing else', () => {
  assert.deepEqual(PageStateWatcher.parse({ status: 'open' }), { status: 'open', reason: undefined });
  assert.deepEqual(PageStateWatcher.parse({ status: 'identifying', error: undefined }), { status: 'identifying', reason: undefined });
  assert.deepEqual(PageStateWatcher.parse({ status: 'failed', error: 'bad_token' }), { status: 'failed', reason: 'bad_token' });
  assert.equal(PageStateWatcher.parse({ status: 'maybe' }), undefined, 'status must be a known state');
  assert.equal(PageStateWatcher.parse({ error: 'bad_token' }), undefined, 'a status is required');
  assert.equal(PageStateWatcher.parse('oxylabs-page-status - {"status":"open"}'), undefined, 'console text is not a message');
  assert.equal(PageStateWatcher.parse(null), undefined);
});

test('drained messages feed the buffer and resolve waiters', async () => {
  const w = new PageStateWatcher();
  const { page, queue } = fakePage();

  const waiter = w.waitFor(1000, { pageId: w.pageIdOf(page) });
  queue.push({ status: 'identifying' }, { status: 'closed' }, { nonsense: true }, { status: 'open' });
  await w.drain(page);

  const ev = await waiter;
  assert.equal(ev?.status, 'open', 'transient statuses do not resolve the waiter');
  assert.equal(ev?.reason, undefined);
  assert.equal(ev?.pageUrl, 'https://site.test/');
  assert.equal(ev?.pageId, w.pageIdOf(page));
  assert.equal(ev?.text, 'oxylabs-page-status - {"status":"open"}');
  assert.equal(w.recent().length, 3, 'every status is recorded, other messages are not');
  assert.equal(w.forPage(w.pageIdOf(page)).length, 3);
  assert.equal(w.last(), ev);
  assert.equal(queue.length, 0, 'the queue is emptied');

  const transient = w.waitFor(1000, { transient: true });
  queue.push({ status: 'identifying' });
  await w.drain(page);
  assert.equal((await transient)?.status, 'identifying');

  queue.push({ status: 'failed', error: 'bad_token' });
  await w.drain(page);
  assert.equal(w.last()?.text, 'oxylabs-page-status - {"status":"failed","error":"bad_token"}');
});

test('a poll during navigation records nothing and does not throw', async () => {
  const w = new PageStateWatcher();
  const { page, queue, fail } = fakePage();
  queue.push({ status: 'open' });
  fail.now = true;
  await w.drain(page);
  assert.equal(w.recent().length, 0);
  fail.now = false;
  await w.drain(page);
  assert.equal(w.recent().length, 1, 'the next poll picks the status up');
});

test('a wait times out without a status and ignores other pages', async () => {
  const w = new PageStateWatcher();
  const { page, queue } = fakePage();
  const other = fakePage('https://other.test/');

  const waiter = w.waitFor(50, { pageId: w.pageIdOf(other.page) });
  queue.push({ status: 'open' });
  await w.drain(page);
  assert.equal(await waiter, undefined);
  assert.equal(w.recent().length, 1, 'still recorded');
  assert.equal(w.forPage(w.pageIdOf(other.page)).length, 0, 'filed under the page it came from');
  assert.notEqual(w.pageIdOf(page), w.pageIdOf(other.page));
});

test('a wait follows the page across its navigations and ends on abort', async () => {
  const w = new PageStateWatcher();
  const { page, queue } = fakePage();
  const pageId = w.pageIdOf(page);

  const waiter = w.waitFor(1000, { pageId });
  queue.push({ status: 'closed' });
  await w.drain(page);
  (page as unknown as { url: () => string }).url = () => 'https://site.test/after-challenge';
  queue.push({ status: 'open' });
  await w.drain(page);
  const ev = await waiter;
  assert.equal(ev?.status, 'open');
  assert.equal(ev?.pageUrl, 'https://site.test/after-challenge', 'the URL changed, the page id did not');

  const abort = new AbortController();
  const aborted = w.waitFor(1000, { pageId, signal: abort.signal });
  abort.abort();
  assert.equal(await aborted, undefined);
  assert.equal(await w.waitFor(1000, { pageId, signal: abort.signal }), undefined, 'an already aborted signal resolves at once');
});

test('lastHandled finds the open that ended a closed, across the navigation the token causes', () => {
  const ev = (status: PageState['status'], at: number): PageState => ({ at, pageId: 1, pageUrl: 'u', text: '', status });
  assert.equal(lastHandled([]), undefined);
  assert.equal(lastHandled([ev('identifying', 1), ev('open', 2)]), undefined, 'open without closed is not a handled challenge');
  assert.equal(lastHandled([ev('identifying', 1), ev('closed', 2), ev('failed', 3)]), undefined);
  assert.equal(lastHandled([ev('closed', 1), ev('identifying', 2), ev('open', 3)])?.at, 3);
  assert.equal(lastHandled([ev('closed', 1), ev('open', 2), ev('identifying', 3), ev('open', 4)])?.at, 2, 'the latest handled one');
  assert.equal(lastHandled([ev('closed', 1), ev('failed', 2), ev('identifying', 3), ev('open', 4)]), undefined, 'a failed resets');
});

test('trigger posts the handle message into the page', async () => {
  const w = new PageStateWatcher();
  const { page, evaluated } = fakePage();

  await w.trigger(page);

  assert.deepEqual(evaluated, [PAGE_HANDLE]);
});
