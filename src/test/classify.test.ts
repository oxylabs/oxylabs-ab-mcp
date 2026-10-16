// Fixtures for every page classification verdict.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../hb/classify.js';
import { currentNavError } from '../hb/session.js';

const big = 'x'.repeat(2000);

test('restricted target wins over everything', () => {
  const c = classify({ url: 'https://bank.example', lastNavError: 'Protocol error: 1337 Invalid target', status: 403 });
  assert.equal(c.verdict, 'restricted-target');
  assert.equal(c.retry, false);
});

test('x-error-description means Oxylabs network', () => {
  const c = classify({ url: 'https://a.example', status: 502, headers: { 'X-Error-Description': 'proxy timeout' } });
  assert.equal(c.verdict, 'oxylabs-network');
  assert.equal(c.retry, true);
});

test('vendor block pages are hard blocks the page handler does not act on', () => {
  assert.equal(classify({ url: 'https://a', status: 403, bodySnippet: 'Contact: DataAccess@datadome.co' }).verdict, 'hard-block');
  assert.equal(classify({ url: 'https://a', status: 200, frameUrls: ['https://geo.captcha-delivery.com/captcha/'] }).verdict, 'hard-block');
  assert.equal(classify({ url: 'https://a', status: 403, cookieNames: ['datadome'] }).verdict, 'hard-block');
});

test('verification interstitials are challenges the page handler acts on', () => {
  const c = classify({ url: 'https://a', status: 503, title: 'Just a moment...', bodySnippet: big });
  assert.equal(c.verdict, 'challenge');
  assert.equal(c.challenge_supported, true);
  assert.equal(classify({ url: 'https://a', status: 403, headers: { 'cf-mitigated': 'challenge' } }).verdict, 'challenge');
});

test('generic challenge frames', () => {
  assert.equal(classify({ url: 'https://a', status: 200, frameUrls: ['https://challenges.cloudflare.com/turnstile/v0/'] , bodySnippet: big}).verdict, 'challenge');
  assert.equal(classify({ url: 'https://a', status: 200, bodySnippet: `${big} verify you are human` }).verdict, 'challenge');
});

test('evidence names the signal, never the vendor', () => {
  const texts = [
    classify({ url: 'https://a', status: 200, frameUrls: ['https://geo.captcha-delivery.com/captcha/'] }),
    classify({ url: 'https://a', status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    classify({ url: 'https://a', status: 200, frameUrls: ['https://challenges.cloudflare.com/turnstile/v0/'], bodySnippet: big }),
  ].flatMap((c) => c.evidence);
  for (const t of texts) assert.doesNotMatch(t, /cloudflare|datadome|captcha-delivery|cf-mitigated|hcaptcha|recaptcha/i, t);
});

test('the page handler state decides once it reports the page open', () => {
  const frame = ['https://challenges.cloudflare.com/turnstile/v0/'];
  const handled = classify({ url: 'https://a', status: 200, frameUrls: frame, bodySnippet: big, lastPageState: { status: 'open' }, challengeHandled: true });
  assert.equal(handled.verdict, 'ok');
  assert.ok(handled.evidence.includes('challenge handled by the page handler'));

  const notActedOn = classify({ url: 'https://a', status: 200, frameUrls: frame, bodySnippet: big, lastPageState: { status: 'open' } });
  assert.equal(notActedOn.verdict, 'ok', 'a frame the handler found nothing in is not a challenge it acts on');

  const stillBlocked = classify({ url: 'https://a', status: 503, title: 'Just a moment...', bodySnippet: big, lastPageState: { status: 'open' } });
  assert.equal(stillBlocked.verdict, 'hard-block', 'interstitial text with nothing to act on is a block');
  assert.equal(stillBlocked.challenge_supported, false);

  assert.equal(classify({ url: 'https://a', status: 200, frameUrls: frame, bodySnippet: big, lastPageState: { status: 'closed' } }).verdict, 'challenge');
  assert.equal(classify({ url: 'https://a', status: 200, bodySnippet: big, lastPageState: { status: 'failed', reason: 'bad_token' } }).verdict, 'challenge');
  assert.equal(classify({ url: 'https://a', status: 200, bodySnippet: big, lastPageState: { status: 'open' }, challengeHandled: true }).verdict, 'ok');
});

test('a failed navigation is a navigation error to retry, not a soft block', () => {
  const net = classify({ url: 'https://a/items', lastNavError: 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://a/items', bodySnippet: 'This site can’t be reached' });
  assert.equal(net.verdict, 'navigation-error');
  assert.equal(net.retry, true);
  assert.deepEqual(net.evidence, ['navigation error: net::ERR_NAME_NOT_RESOLVED']);
  const errorPage = classify({ url: 'chrome-error://chromewebdata/', status: 200, bodySnippet: 'tiny' });
  assert.equal(errorPage.verdict, 'navigation-error');
  assert.equal(classify({ url: 'https://bank.example', lastNavError: 'net::ERR_FAILED 1337 Invalid target' }).verdict, 'restricted-target', 'restricted target still wins');
});

test('access-denied pages, target errors, soft blocks and ok', () => {
  assert.equal(classify({ url: 'https://a', status: 403, bodySnippet: 'Access Denied ... Reference #18.abc' }).verdict, 'hard-block');
  assert.equal(classify({ url: 'https://a', status: 404, bodySnippet: big }).verdict, 'target-error');
  assert.equal(classify({ url: 'https://a/login', status: 200, bodySnippet: big }).verdict, 'soft-block');
  assert.equal(classify({ url: 'https://a/items', status: 200, bodySnippet: 'tiny' }).verdict, 'soft-block');
  assert.equal(classify({ url: 'https://a/items', status: 200, bodySnippet: big }).verdict, 'ok');
});

test('a navigation failure counts only until the page loads again, and never when stale', () => {
  const now = 100_000;
  const failed = { text: 'net::ERR_CONNECTION_RESET', at: 90_000 };
  assert.equal(currentNavError([failed], undefined, now), 'net::ERR_CONNECTION_RESET');
  assert.equal(currentNavError([failed], 80_000, now), 'net::ERR_CONNECTION_RESET', 'newer than the last response');
  assert.equal(currentNavError([failed], 95_000, now), undefined, 'the page loaded since');
  assert.equal(currentNavError([failed], undefined, 90_000 + 60_000), undefined, 'older than the TTL');
  assert.equal(currentNavError([undefined, undefined], undefined, now), undefined);
  const older = { text: 'Protocol error: 1337 Invalid target', at: 85_000 };
  assert.equal(currentNavError([failed, older], undefined, now), 'net::ERR_CONNECTION_RESET', 'the newest candidate wins');
});
