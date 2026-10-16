// Live tests (HB_INTEGRATION=1) against hb.oxylabs.io: full MCP flow on one session, two sessions in
// different countries at once, and the URL auth mode handshake.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../mcp/server.js';
import { resolveSettings } from '../../settings.js';

const enabled = process.env.HB_INTEGRATION === '1';
const referenceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'reference');

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('\n');
}

function json<T>(res: { content: Array<{ type: string; text?: string }> }): T {
  const m = /```json\n([\s\S]*?)\n```/.exec(text(res));
  assert.ok(m, 'result has a JSON block');
  return JSON.parse(m[1]) as T;
}

test('end-to-end through the MCP surface against the live service', { skip: !enabled, timeout: 300000 }, async () => {
  const settings = resolveSettings(process.env);
  assert.ok(settings.username && settings.password, 'credentials required');
  const hb = await buildServer(settings, { referenceDir, log: (m) => process.stderr.write(`  ${m}\n`) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await hb.server.connect(st);
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(ct);
  try {
    const connect = await client.callTool({ name: 'hb_connect', arguments: { label: 'us', p_cc: 'US', page_handler: false } });
    assert.equal(connect.isError, undefined, text(connect as never));
    const info = json<{ label: string; session_id: string; live_url: string; effective_params: Record<string, unknown> }>(connect as never);
    assert.equal(info.label, 'us');
    assert.match(info.session_id, /^[A-Za-z0-9-]+$/);
    assert.ok(info.live_url.includes(info.session_id));
    assert.deepEqual(info.effective_params, { p_cc: 'US', page_handler: false });
    assert.doesNotMatch(text(connect as never), new RegExp(settings.password!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const nav = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://ip.oxylabs.io/location', session: 'us' } });
    assert.equal(nav.isError, undefined, text(nav as never));
    assert.match(text(nav as never), /ip\.oxylabs\.io\/location/);

    const snap = await client.callTool({ name: 'browser_snapshot', arguments: { session: 'us' } });
    assert.equal(snap.isError, undefined, text(snap as never));
    assert.match(text(snap as never), /ip.*providers.*country/);

    const cls = await client.callTool({ name: 'hb_classify_page', arguments: { session: 'us' } });
    const verdict = json<{ verdict: string; status: number }>(cls as never);
    assert.equal(verdict.verdict, 'ok', text(cls as never));
    assert.equal(verdict.status, 200);

    const sinfo = json<{ detail: { connected: boolean; session_id: string; tabs: unknown[] } }>((await client.callTool({ name: 'hb_session_info', arguments: { session: 'us' } })) as never);
    assert.equal(sinfo.detail.connected, true);
    assert.equal(sinfo.detail.session_id, info.session_id);
    assert.ok(sinfo.detail.tabs.length >= 1);

    const list = json<{ items: Array<{ id: string; is_ours: boolean }> }>((await client.callTool({ name: 'hb_sessions_list', arguments: {} })) as never);
    assert.ok(list.items.some((s) => s.id === info.session_id && s.is_ours), 'dashboard lists our session');

    const shot = await client.callTool({ name: 'browser_take_screenshot', arguments: { session: 'us' } });
    assert.equal(shot.isError, undefined, text(shot as never));
    assert.ok((shot.content as Array<{ type: string }>).some((c) => c.type === 'image'), 'screenshot returns an image part');

    const close = await client.callTool({ name: 'browser_close', arguments: { session: 'us' } });
    assert.match(text(close as never), new RegExp(`HB session "us" \\(${info.session_id}\\) ended`));

    // Named session lifecycle via hb_disconnect messaging.
    const named = await client.callTool({ name: 'hb_connect', arguments: { session_name: `hbmcp-${Date.now().toString(36)}`, p_cc: 'US', page_handler: false } });
    assert.equal(named.isError, undefined, text(named as never));
    const namedLabel = json<{ label: string }>(named as never).label;
    assert.match(namedLabel, /^s\d+$/);
    const disc = await client.callTool({ name: 'hb_disconnect', arguments: { session: namedLabel } });
    assert.match(text(disc as never), /can be resumed within 10 minutes/);

    // A closed session reconnects (new HB session, same parameters) on its next browser_* call.
    const again = await client.callTool({ name: 'hb_connect', arguments: { label: 'again', p_cc: 'US', page_handler: false } });
    const againId = json<{ session_id: string }>(again as never).session_id;
    await client.callTool({ name: 'hb_disconnect', arguments: { session: 'again' } });
    const nav2 = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com', session: 'again' } });
    assert.equal(nav2.isError, true, 'closed sessions are gone, not silently reconnected');
    assert.match(text(nav2 as never), /No HB session/);
    void againId;
  } finally {
    await hb.shutdown();
  }
});

test('two sessions in different countries at the same time', { skip: !enabled, timeout: 300000 }, async () => {
  const settings = resolveSettings(process.env);
  const hb = await buildServer(settings, { referenceDir, log: (m) => process.stderr.write(`  ${m}\n`) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await hb.server.connect(st);
  const client = new Client({ name: 'multi', version: '0' });
  await client.connect(ct);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  try {
    const [de, kr] = await Promise.all([
      call('hb_connect', { label: 'de', p_cc: 'DE', page_handler: false }),
      call('hb_connect', { label: 'kr', p_cc: 'KR', page_handler: false }),
    ]);
    assert.equal(de.isError, undefined, text(de as never));
    assert.equal(kr.isError, undefined, text(kr as never));
    const deId = json<{ session_id: string }>(de as never).session_id;
    const krId = json<{ session_id: string }>(kr as never).session_id;
    assert.notEqual(deId, krId);

    const [navDe, navKr] = await Promise.all([
      call('browser_navigate', { url: 'https://ip.oxylabs.io/location', session: 'de' }),
      call('browser_navigate', { url: 'https://ip.oxylabs.io/location', session: 'kr' }),
    ]);
    assert.equal(navDe.isError, undefined, text(navDe as never));
    assert.equal(navKr.isError, undefined, text(navKr as never));

    const country = async (session: string) => {
      const res = await call('browser_evaluate', { function: '() => JSON.parse(document.body.innerText).providers.ip2location.country', session });
      assert.equal(res.isError, undefined, text(res as never));
      const m = /"([A-Z]{2})"/.exec(text(res as never));
      assert.ok(m, `country in ${text(res as never)}`);
      return m![1];
    };
    assert.equal(await country('de'), 'DE');
    assert.equal(await country('kr'), 'KR');

    const info = json<{ sessions: Array<{ label: string; connected: boolean }> }>((await call('hb_session_info', {})) as never);
    assert.deepEqual(info.sessions.map((s) => s.label).sort(), ['de', 'kr']);
    assert.ok(info.sessions.every((s) => s.connected));

    const closeDe = await call('browser_close', { session: 'de' });
    assert.match(text(closeDe as never), /HB session "de" \(.*\) ended\. Open sessions: kr\./);
    const closeAll = await call('hb_disconnect', { all: true });
    assert.match(text(closeAll as never), /Closed 1 HB session\(s\): kr/);
  } finally {
    await hb.shutdown();
  }
});

test('url auth mode handshake', { skip: !enabled, timeout: 120000 }, async () => {
  const settings = resolveSettings({ ...process.env, HB_AUTH_MODE: 'url' });
  const hb = await buildServer(settings, { referenceDir });
  try {
    const info = await hb.hub.connect('urlmode', { p_cc: 'US' });
    assert.match(info.session_id, /^[A-Za-z0-9-]+$/);
  } finally {
    await hb.shutdown();
  }
});
