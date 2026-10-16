#!/usr/bin/env node
// Command-line entry point of oxylabs-ab-mcp: parses flags, resolves settings, builds the composite MCP server
// and serves it over stdio (default) or Streamable HTTP; installs exit hooks that close every HB session.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer, SERVER_VERSION } from './mcp/server.js';
import { describeSettings, resolveSettings, type CliFlags } from './settings.js';
import { startHttp } from './mcp/http.js';
import { HB_ENDPOINT } from './hb/url.js';

const referenceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'reference');

const program = new Command()
  .name('oxylabs-ab-mcp')
  .description('Playwright MCP server for the Oxylabs Agent Browser')
  .version(SERVER_VERSION)
  .option('--default-params <query>', 'query string applied to every connection, e.g. "p_cc=US" (env HB_DEFAULT_PARAMS)')
  .option('--caps <caps>', 'extra Playwright MCP capabilities, comma-separated: vision,pdf,network,storage,testing,devtools,config (env HB_CAPS, default vision,pdf)')
  .option('--output-dir <path>', 'directory for screenshots, PDFs and other files (env HB_OUTPUT_DIR)')
  .option('--timeout-action <ms>', 'Playwright action timeout', (v) => Number(v))
  .option('--timeout-navigation <ms>', 'Playwright navigation timeout (default 60000)', (v) => Number(v))
  .option('--connect-timeout <ms>', 'HB connect timeout per attempt (env HB_CONNECT_TIMEOUT_MS, default 30000)', (v) => Number(v))
  .option('--config <file>', 'Playwright MCP JSON config file merged under the oxylabs-ab-mcp settings (env HB_PLAYWRIGHT_CONFIG)')
  .option('--port <port>', 'serve Streamable HTTP on this port instead of stdio', (v) => Number(v))
  .option('--host <host>', 'bind host for --port (default 127.0.0.1)')
  .option('--check', 'print the resolved settings (password masked) and exit')
  .option('--quiet', 'do not log to stderr');

program.parse();
const opts = program.opts<CliFlags & { check?: boolean; quiet?: boolean }>();

const log = opts.quiet ? () => undefined : (m: string) => process.stderr.write(`[oxylabs-ab-mcp] ${m}\n`);

async function main(): Promise<void> {
  const settings = resolveSettings(process.env, opts);
  if (opts.check) {
    process.stdout.write(`${JSON.stringify(describeSettings(settings), null, 2)}\n`);
    return;
  }
  if (!settings.username || !settings.password) {
    log('warning: OXY_AB_USERNAME / OXY_AB_PASSWORD not set; tools that need the service will explain how to configure them');
  }

  const hb = await buildServer(settings, { referenceDir, log });
  let exiting = false;
  const exit = async (reason: string, code = 0) => {
    if (exiting) return;
    exiting = true;
    log(`shutting down (${reason})`);
    await Promise.race([hb.shutdown(), new Promise<void>((r) => setTimeout(r, 6000))]).catch(() => undefined);
    process.exit(code);
  };
  process.on('SIGINT', () => void exit('SIGINT'));
  process.on('SIGTERM', () => void exit('SIGTERM'));
  process.on('SIGHUP', () => void exit('SIGHUP'));

  if (settings.port !== undefined) {
    await startHttp(hb.server, settings.host, settings.port, log);
    return;
  }
  const transport = new StdioServerTransport();
  transport.onclose = () => void exit('client disconnected');
  process.stdin.on('end', () => void exit('stdin closed'));
  await hb.server.connect(transport);
  log(`ready (stdio), endpoint ${HB_ENDPOINT}, ${hb.hub.tools.length} Playwright tools + hb_* tools, up to ${settings.maxSessions} sessions`);
}

main().catch((err) => {
  process.stderr.write(`[oxylabs-ab-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
