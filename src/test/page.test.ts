// hb_page_handle: the outcome of a handle round from the round's states and the page's handled challenge.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PageState } from '../hb/pageState.js';
import { handleOutcome } from '../mcp/tools/page.js';

const ev = (status: PageState['status'], at: number, reason?: string): PageState => ({ at, pageId: 1, pageUrl: 'https://site.test/', text: '', status, reason });

test('a round that closed and opened completed', () => {
  const round = [ev('identifying', 10), ev('closed', 11), ev('open', 40)];
  assert.equal(handleOutcome(round, round[2], undefined), 'completed');
  assert.equal(handleOutcome(round, round[2], ev('open', 4)), 'completed', 'an earlier handling does not matter');
});

test('a failed round is an error, whatever happened before', () => {
  const round = [ev('identifying', 10), ev('closed', 11), ev('failed', 40, 'bad_token')];
  assert.equal(handleOutcome(round, round[2], ev('open', 4)), 'error');
});

test('open without closed is not-found on a fresh document, already-handled on a handled one', () => {
  const round = [ev('identifying', 10), ev('open', 13)];
  assert.equal(handleOutcome(round, round[1], undefined), 'not-found');
  assert.equal(handleOutcome(round, round[1], ev('open', 4)), 'already-handled');
});

test('no terminal state is a timeout', () => {
  assert.equal(handleOutcome([ev('identifying', 10), ev('closed', 11)], undefined, ev('open', 4)), 'timeout');
});
