// Live test (HB_INTEGRATION=1): drives the real stdio CLI as a child process through the MCP client SDK.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const enabled = process.env.HB_INTEGRATION === '1';
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.js');

function text(res: { content: unknown }): string {
  return (res.content as Array<{ type: string; text?: string }>).map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('\n');
}

test('the stdio CLI serves the composite tool set and closes the HB session on exit', { skip: !enabled, timeout: 240000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, '--quiet'],
    env: { ...process.env } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'cli-smoke', version: '0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'browser_navigate') && tools.some((t) => t.name === 'hb_connect'));

    const conn = await client.callTool({ name: 'hb_connect', arguments: { label: 'cli', p_cc: 'US' } }, undefined, { timeout: 180000 });
    assert.equal(conn.isError, undefined, text(conn as never));
    const nav = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com', session: 'cli' } }, undefined, { timeout: 180000 });
    assert.equal(nav.isError, undefined, text(nav as never));

    const info = await client.callTool({ name: 'hb_session_info', arguments: { session: 'cli' } });
    const m = /"session_id": "([^"]+)"/.exec(text(info as never));
    assert.ok(m, 'session id present');

    const closed = await client.callTool({ name: 'browser_close', arguments: { session: 'cli' } });
    assert.match(text(closed as never), new RegExp(`HB session "cli" \\(${m![1]}\\) ended`));
  } finally {
    await client.close();
  }
});
