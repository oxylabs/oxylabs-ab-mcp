// Handshake error parsing, the retryable matrix and backoff bounds/budget.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explain, isRetryable, parseHandshakeError } from '../hb/errors.js';
import { backoffDelay, BackoffExhausted, withBackoff } from '../hb/backoff.js';

test('parses the Playwright handshake message format', () => {
  const e = parseHandshakeError(
    new Error('browserType.connectOverCDP: WebSocket error: wss://user:pw@hb.oxylabs.io/ 400 Bad Request\nkeep_alive requires session_name'),
  );
  assert.equal(e.status, 400);
  assert.equal(e.statusText, 'Bad Request');
  assert.equal(e.body, 'keep_alive requires session_name');
  assert.equal(isRetryable(e), false);
  assert.match(explain(e), /add session_name/);
});

test('explains the challenge handling rejection in its new and old wording', () => {
  for (const body of ['page handler is not enabled for this account']) {
    const e = parseHandshakeError(new Error(`WebSocket error: wss://x/ 400 Bad Request\n${body}`));
    assert.match(explain(e), /drop page_handler/);
  }
});

test('parses CDP codes and the Puppeteer format', () => {
  const e = parseHandshakeError(new Error('WebSocket error: wss://x/ 429 Too Many Requests\nCDP_SESSION_RATE_LIMIT_REACHED'));
  assert.equal(e.status, 429);
  assert.equal(e.code, 'CDP_SESSION_RATE_LIMIT_REACHED');
  assert.equal(isRetryable(e), true);
  const p = parseHandshakeError(new Error('Unexpected server response: 503'));
  assert.equal(p.status, 503);
  assert.equal(isRetryable(p), true);
});

const matrix: Array<[string, boolean]> = [
  ['wss://x/ 401 Unauthorized\ninvalid credentials', false],
  ['wss://x/ 403 Forbidden\nprofile limit reached (5 profiles maximum)', false],
  ['wss://x/ 409 Conflict\nprofile is already in use by another session', false],
  ['wss://x/ 429 Too Many Requests\nCDP_MAX_CONCURRENT_SESSIONS_REACHED', true],
  ['wss://x/ 500 Internal Server Error\nCDP_GENERAL_ERROR', true],
  ['wss://x/ 503 Service Unavailable\nqueue timeout', true],
  ['Target closed CDP_BAD_PROXY', true],
  ['browserType.connectOverCDP: Timeout 30000ms exceeded.', true],
  ['read ECONNRESET', true],
  ['Protocol error (Page.navigate): 1337 Invalid target', false],
  ['something unexplained', false],
];
for (const [msg, expected] of matrix) {
  test(`retryable(${JSON.stringify(msg.split('\n')[0])}) = ${expected}`, () => {
    assert.equal(isRetryable(parseHandshakeError(new Error(msg))), expected);
  });
}

test('backoff delays stay within bounds and the budget is enforced', async () => {
  for (let a = 0; a < 8; a++) {
    const d = backoffDelay(a, 1000, 60000, () => 1);
    assert.ok(d <= 60000 && d >= 500);
  }
  const delays: number[] = [];
  let calls = 0;
  await assert.rejects(
    withBackoff(
      async () => {
        calls++;
        throw new Error('retry me');
      },
      { attempts: 3, baseMs: 10, capMs: 100, budgetMs: 10000, random: () => 0, sleep: async (ms) => void delays.push(ms) },
    ),
    (err: unknown) => err instanceof BackoffExhausted && err.attempts === 3,
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [5, 10]);

  await assert.rejects(
    withBackoff(async () => { throw new Error('x'); }, { attempts: 6, baseMs: 1000, capMs: 60000, budgetMs: 100, random: () => 1, sleep: async () => {} }),
    (err: unknown) => err instanceof BackoffExhausted && err.budgetHit,
  );

  await assert.rejects(
    withBackoff(async () => { throw new Error('fatal'); }, { isRetryable: () => false, sleep: async () => {} }),
    /fatal/,
  );
});
