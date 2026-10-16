// Dashboard client behaviour against a fake fetch: Basic auth, request spacing, 429 retry, error hints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DashboardClient, DashboardError, describeLimits } from '../hb/dashboard.js';
import { Redactor } from '../redact.js';

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

test('sends basic auth, throttles and retries 429', async () => {
  const calls: Array<{ url: string; auth: string; at: number }> = [];
  let first = true;
  const client = new DashboardClient(
    'http://localhost:8872/dashboard/',
    { username: 'u', password: 'p' },
    new Redactor(),
    {
      minGapMs: 30,
      fetchImpl: fakeFetch((url, init) => {
        calls.push({ url, auth: (init?.headers as Record<string, string>).Authorization, at: Date.now() });
        if (first) {
          first = false;
          return new Response('{"error":"rate limit exceeded"}', { status: 429 });
        }
        return new Response(JSON.stringify({ items: [], page: 1, page_size: 20, total: 0, has_more: false }), { status: 200 });
      }),
    },
  );
  const [list, limits] = await Promise.all([client.listSessions(), client.sessionLimits().catch(() => undefined)]);
  assert.equal(list.total, 0);
  assert.ok(calls.length >= 2);
  assert.equal(calls[0].url, 'http://localhost:8872/dashboard/api/v1/sessions?page=1&page_size=20');
  assert.equal(calls[0].auth, `Basic ${Buffer.from('u:p').toString('base64')}`);
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 25, 'requests are spaced');
  void limits;
});

test('surfaces JSON errors with hints and handles 204', async () => {
  const client = new DashboardClient('https://hb.oxylabs.io/dashboard', { username: 'u', password: 'p' }, new Redactor(), {
    minGapMs: 0,
    fetchImpl: fakeFetch((url, init) => {
      if (url.endsWith('/stop') && init?.method === 'POST') return new Response(null, { status: 204 });
      return new Response('{"error":"profile is locked"}', { status: 409 });
    }),
  });
  assert.equal(await client.stopSession('abc'), undefined);
  await assert.rejects(client.deleteProfile('x'), (e: unknown) => e instanceof DashboardError && e.status === 409 && /locked by a live session/.test(e.message));
});

test('describes limit semantics', () => {
  assert.equal(describeLimits({ used: 2, limit: 5 }), 'used 2 of 5');
  assert.equal(describeLimits({ used: 0, limit: 0 }), 'used 0; feature disabled for this account');
  assert.equal(describeLimits({ used: 3, limit: -1 }), 'used 3; unlimited');
});
