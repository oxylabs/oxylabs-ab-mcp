// Endpoint constants, websocket URL concatenation and the Basic auth header encoding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthHeader, buildWsUrl, HB_DASHBOARD_URL, HB_ENDPOINT, HB_VNC_URL, liveViewUrl } from '../hb/url.js';

test('endpoints are the public hb.oxylabs.io constants', () => {
  assert.equal(HB_ENDPOINT, 'wss://hb.oxylabs.io');
  assert.equal(HB_DASHBOARD_URL, 'https://hb.oxylabs.io/dashboard');
  assert.equal(HB_VNC_URL, 'https://hb.oxylabs.io');
  assert.equal(liveViewUrl('abc123'), 'https://hb.oxylabs.io/novnc/?id=abc123');
});

test('builds ws URLs by concatenation', () => {
  assert.equal(buildWsUrl('p_cc=US'), 'wss://hb.oxylabs.io/?p_cc=US');
  assert.equal(buildWsUrl(''), 'wss://hb.oxylabs.io/');
  assert.equal(buildWsUrl('p_cc=US', { username: 'user_ab12', password: 'p@ss:/w%rd' }), 'wss://user_ab12:p@ss:/w%rd@hb.oxylabs.io/?p_cc=US');
});

test('auth header uses base64url only when needed and keeps padding', () => {
  assert.equal(buildAuthHeader('user', 'pass'), `Basic ${Buffer.from('user:pass').toString('base64')}`);
  const header = buildAuthHeader('u', '\u00ff\u00fe?>');
  assert.match(header, /^Basic [A-Za-z0-9_-]+=*$/);
  assert.doesNotMatch(header, /[+/]/);
  const std = Buffer.from('u:\u00ff\u00fe?>').toString('base64');
  assert.equal(header.slice(6), std.replace(/\+/g, '-').replace(/\//g, '_'));
});
