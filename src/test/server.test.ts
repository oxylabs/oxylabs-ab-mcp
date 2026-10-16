// Offline tests of the composite server over an in-memory MCP client: tool/resource listing, argument
// validation, session routing errors, redaction of connect failures, behaviour without credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../mcp/server.js';
import { resolveSettings } from '../settings.js';

const referenceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'reference');

async function connectedClient(env: NodeJS.ProcessEnv) {
  const hb = await buildServer(resolveSettings(env), {
    referenceDir,
    connectOverCDP: async (url) => {
      // Playwright embeds the full URL (incl. userinfo in url auth mode) in handshake errors.
      throw new Error(`browserType.connectOverCDP: WebSocket error: ${url.replace('wss://', 'wss://u:secretpw@')} 401 Unauthorized\ninvalid credentials`);
    },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await hb.server.connect(st);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
  return { hb, client };
}

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('\n');
}

test('composite server lists Playwright and hb tools, resources and instructions', async () => {
  const { hb, client } = await connectedClient({ OXY_HB_USERNAME: 'u', OXY_HB_PASSWORD: 'secretpw' });
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('browser_navigate'));
    assert.ok(names.includes('hb_connect'));
    assert.ok(names.includes('hb_classify_page'));
    assert.ok(names.includes('hb_page_handle'));
    assert.ok(!names.includes('hb_session_select'));
    const nav = tools.find((t) => t.name === 'browser_navigate')!;
    const navSchema = nav.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    assert.ok('session' in navSchema.properties, 'browser_* tools gain a session argument');
    assert.deepEqual(navSchema.required, ['session', 'url']);
    assert.ok(!names.includes('browser_install'));
    const connect = tools.find((t) => t.name === 'hb_connect')!;
    const props = (connect.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok('p_cc' in props && 'page_handler' in props && 'replace_defaults' in props);
    assert.ok(!('p_fp_id' in props));
    assert.match(client.getInstructions() ?? '', /Oxylabs Agent Browser/);

    const { resources } = await client.listResources();
    assert.equal(resources.length, 3);
    const read = await client.readResource({ uri: 'hb://reference/params' });
    assert.match(String((read.contents[0] as { text?: string }).text), /proxy_resi_ses_id/);
  } finally {
    await hb.shutdown();
  }
});

test('hb tools validate offline and never leak the password', async () => {
  const { hb, client } = await connectedClient({ OXY_HB_USERNAME: 'u', OXY_HB_PASSWORD: 'secretpw', HB_CONNECT_ATTEMPTS: '1' });
  try {
    const bad = await client.callTool({ name: 'hb_connect', arguments: { proxy: 'dc', p_cc: 'US' } });
    assert.equal(bad.isError, true);
    assert.match(text(bad as never), /proxy=dc does not support \[p_cc\]/);

    const internal = await client.callTool({ name: 'hb_connect', arguments: { p_fp_id: '1' } });
    assert.match(text(internal as never), /p_fp_id is not a public parameter/);

    const info = await client.callTool({ name: 'hb_session_info', arguments: {} });
    assert.match(text(info as never), /No HB session is open/);
    const noLabel = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } });
    assert.equal(noLabel.isError, true);
    assert.match(text(noLabel as never), /requires session=<label>/);

    const ref = await client.callTool({ name: 'hb_reference', arguments: { topic: 'errors' } });
    assert.match(text(ref as never), /CDP_MAX_CONCURRENT_SESSIONS_REACHED/);

    const hidden = await client.callTool({ name: 'browser_resize', arguments: { width: 1, height: 1 } });
    assert.equal(hidden.isError, true);
    assert.match(text(hidden as never), /owns the viewport/);

    // A handshake failure must be explained (401 -> credentials) and redacted.
    const conn = await client.callTool({ name: 'hb_connect', arguments: { p_cc: 'US' } });
    assert.equal(conn.isError, true);
    const t = text(conn as never);
    assert.match(t, /Could not connect to the Oxylabs Agent Browser after 1 attempt\(s\): 401 Unauthorized: invalid credentials\. Fix: check OXY_HB_USERNAME/);
    assert.doesNotMatch(t, /secretpw/);

    // A failed connect leaves no slot behind; unknown labels are rejected without connecting.
    const infoAfter = await client.callTool({ name: 'hb_session_info', arguments: {} });
    assert.match(text(infoAfter as never), /No HB session is open/);
    const unknown = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com', session: 'nope' } });
    assert.equal(unknown.isError, true);
    assert.match(text(unknown as never), /No HB session is open\. Call hb_connect first/);
    const badLabel = await client.callTool({ name: 'hb_connect', arguments: { label: 'bad label!' } });
    assert.match(text(badLabel as never), /label must be/);
    const disc = await client.callTool({ name: 'hb_disconnect', arguments: {} });
    assert.equal(disc.isError, true);
    assert.match(text(disc as never), /Pass session=<label>/);
    const discAll = await client.callTool({ name: 'hb_disconnect', arguments: { all: true } });
    assert.match(text(discAll as never), /No HB session was open/);
  } finally {
    await hb.shutdown();
  }
});

test('without credentials the server starts and explains', async () => {
  const { hb, client } = await connectedClient({});
  try {
    const res = await client.callTool({ name: 'hb_sessions_list', arguments: {} });
    assert.equal(res.isError, true);
    assert.match(text(res as never), /OXY_HB_USERNAME and OXY_HB_PASSWORD/);
  } finally {
    await hb.shutdown();
  }
});
