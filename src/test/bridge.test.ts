// Verifies the in-process Playwright MCP composition without a browser: single playwright-core copy matching
// the @playwright/mcp pin, tool listing without touching the context getter, hidden tools, error surfacing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { HIDDEN_TOOLS, PlaywrightBridge } from '../mcp/bridge.js';

const require = createRequire(import.meta.url);

test('one playwright-core copy, matching the @playwright/mcp pin', () => {
  const ours = require.resolve('playwright-core/package.json');
  const mcpDir = path.dirname(require.resolve('@playwright/mcp/package.json'));
  const theirs = createRequire(path.join(mcpDir, 'index.js')).resolve('playwright-core/package.json');
  assert.equal(ours, theirs);
  const pinned = require('@playwright/mcp/package.json').dependencies['playwright-core'];
  assert.equal(require(ours).version, pinned);
});

test('lists Playwright tools without touching the context getter; hidden tools removed; getter errors surface as isError', async () => {
  let getterCalls = 0;
  const bridge = await PlaywrightBridge.create({ capabilities: ['vision', 'pdf'] }, async () => {
    getterCalls++;
    throw new Error('no HB connection in unit tests');
  });
  try {
    const names = bridge.tools.map((t) => t.name);
    assert.ok(names.includes('browser_navigate'));
    assert.ok(names.includes('browser_snapshot'));
    assert.ok(names.includes('browser_take_screenshot'));
    assert.ok(names.includes('browser_pdf_save'));
    assert.ok(names.includes('browser_mouse_click_xy'));
    for (const hidden of HIDDEN_TOOLS.keys()) assert.ok(!names.includes(hidden), `${hidden} should be hidden`);
    assert.equal(getterCalls, 0);
    assert.equal(bridge.isBackendLive(), false);

    const res = await bridge.callTool('browser_navigate', { url: 'https://example.com' });
    assert.equal(getterCalls, 1);
    assert.equal(res.isError, true);
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    assert.match(text, /no HB connection in unit tests/);
    assert.equal(bridge.isBackendLive(), false);

    await bridge.resetBackend(); // must not call the getter again
    assert.equal(getterCalls, 1);
  } finally {
    await bridge.close();
  }
});
