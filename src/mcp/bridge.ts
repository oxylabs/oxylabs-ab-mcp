// PlaywrightBridge: hosts one @playwright/mcp server in-process, connects an MCP client to it over a linked
// in-memory transport, exposes its tool list (minus tools that make no sense against HB) and forwards tool
// calls; the Playwright backend is created lazily from the contextGetter on the first call.

import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ContextGetter, PlaywrightConfig } from './pwtypes.js';
import { SERVER_VERSION } from './version.js';

const require = createRequire(import.meta.url);
// `@playwright/mcp` is CJS with `module.exports = { createConnection: tools.createConnection }`, which the
// ESM named-export detector does not see through; go through require() instead.
const { createConnection } = require('@playwright/mcp') as typeof import('@playwright/mcp');

/** Playwright tools that make no sense against the HB service. */
export const HIDDEN_TOOLS: ReadonlyMap<string, string> = new Map([
  ['browser_install', 'oxylabs-ab-mcp drives a remote Oxylabs browser; there is nothing to install locally.'],
  ['browser_resize', 'the Oxylabs Agent Browser owns the viewport as part of the device configuration; Emulation.setDeviceMetricsOverride is ignored by the service.'],
]);

export const INNER_CALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Hosts the Playwright MCP server in-process and talks to it over a linked in-memory transport.
 * The inner backend (and with it the HB connection via `contextGetter`) is created lazily on the first
 * forwarded tool call and recreated after `browser_close`.
 */
export class PlaywrightBridge {
  private backendLive = false;

  private constructor(
    private readonly client: Client,
    readonly tools: Tool[],
    readonly version: string,
  ) {}

  static async create(config: PlaywrightConfig, contextGetter: ContextGetter): Promise<PlaywrightBridge> {
    let bridge: PlaywrightBridge | undefined;
    const getter: ContextGetter = async () => {
      const context = await contextGetter();
      if (bridge) bridge.backendLive = true;
      return context;
    };
    const inner = await createConnection(config, getter);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await inner.connect(serverTransport);
    const client = new Client({ name: 'oxylabs-ab-mcp', version: SERVER_VERSION }, { capabilities: {} });
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const tools = listed.tools.filter((t) => !HIDDEN_TOOLS.has(t.name));
    const version = client.getServerVersion()?.version ?? 'unknown';
    bridge = new PlaywrightBridge(client, tools, version);
    return bridge;
  }

  hasTool(name: string): boolean {
    return this.tools.some((t) => t.name === name);
  }

  isBackendLive(): boolean {
    return this.backendLive;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const result = (await this.client.callTool({ name, arguments: args }, CallToolResultSchema, {
      timeout: INNER_CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
      signal,
    })) as CallToolResult;
    if (name === 'browser_close') this.backendLive = false;
    return result;
  }

  /**
   * Dispose the inner backend so it does not keep a dead BrowserContext. Only sends `browser_close` when a
   * backend exists: on a fresh server that call would create one (and connect to HB) just to close it.
   */
  async resetBackend(): Promise<void> {
    if (!this.backendLive) return;
    this.backendLive = false;
    await this.client
      .callTool({ name: 'browser_close', arguments: {} }, CallToolResultSchema, { timeout: 30000 })
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
