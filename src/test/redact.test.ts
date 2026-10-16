// Redaction of raw, encoded and base64 password spellings in text and MCP results.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor } from '../redact.js';

const password = 'sup3r+secret/pw';
const r = new Redactor([{ name: 'OXY_HB_PASSWORD', value: password, username: 'alice' }]);

test('redacts raw, percent-encoded and base64 spellings', () => {
  const b64 = Buffer.from(`alice:${password}`).toString('base64');
  const msg =
    `browserType.connectOverCDP: WebSocket error: wss://alice:${password}@hb.oxylabs.io/ 400 Bad Request\n` +
    `keep_alive requires session_name enc=${encodeURIComponent(password)} auth=Basic ${b64} url=${b64.replace(/\+/g, '-').replace(/\//g, '_')}`;
  const out = r.text(msg);
  assert.doesNotMatch(out, /sup3r/);
  assert.doesNotMatch(out, new RegExp(b64.replace(/[+/]/g, '.')));
  assert.match(out, /wss:\/\/alice:<secret>OXY_HB_PASSWORD<\/secret>@hb\.oxylabs\.io\/ 400 Bad Request/);
  assert.match(out, /keep_alive requires session_name/);
});

test('result walker touches only text parts and keeps isError', () => {
  const out = r.result({
    isError: true,
    content: [
      { type: 'text', text: `oops ${password}` },
      { type: 'image', data: password, mimeType: 'image/png' },
    ],
  });
  assert.equal(out.isError, true);
  assert.equal(out.content?.[0].text, 'oops <secret>OXY_HB_PASSWORD</secret>');
  assert.equal(out.content?.[1].data, password);
});

test('short or empty secrets are ignored', () => {
  const short = new Redactor([{ name: 'X', value: 'ab' }, { name: 'Y', value: undefined }]);
  assert.equal(short.text('ab ab'), 'ab ab');
});
