// Resolves the server configuration from environment variables and CLI flags (credentials, default HB
// parameters, connect/retry limits, session cap, Playwright MCP config) and forces the Playwright keys oxylabs-ab-mcp
// depends on (chromium, non-isolated context, secrets redaction).

import fs from 'node:fs';
import path from 'node:path';
import type { PlaywrightConfig as Config, ToolCapability } from './mcp/pwtypes.js';
import { paramsFromQueryString, type HbParams } from './hb/params.js';
import { HB_DASHBOARD_URL, HB_ENDPOINT } from './hb/url.js';

export type AuthMode = 'header' | 'url';

export interface CliFlags {
  defaultParams?: string;
  caps?: string;
  outputDir?: string;
  timeoutAction?: number;
  timeoutNavigation?: number;
  connectTimeout?: number;
  config?: string;
  port?: number;
  host?: string;
}

export interface Settings {
  username?: string;
  password?: string;
  authMode: AuthMode;
  defaultParams: HbParams;
  connect: { timeoutMs: number; attempts: number; budgetMs: number };
  maxSessions: number;
  playwright: Config;
  port?: number;
  host: string;
}

export const DEFAULT_CAPS: ToolCapability[] = ['vision', 'pdf'];
const KNOWN_CAPS = new Set<ToolCapability>(['config', 'core', 'network', 'pdf', 'storage', 'testing', 'vision', 'devtools']);

function firstEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const n of names) {
    const v = env[n];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${v}"`);
  return n;
}

function parseCaps(raw: string | undefined): ToolCapability[] {
  if (!raw) return DEFAULT_CAPS;
  const caps = raw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean) as ToolCapability[];
  for (const c of caps) {
    if (!KNOWN_CAPS.has(c)) throw new Error(`unknown capability "${c}"; known: ${[...KNOWN_CAPS].join(', ')}`);
  }
  return caps;
}

function loadUserConfig(file: string | undefined): Config {
  if (!file) return {};
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  const parsed = JSON.parse(text) as Config;
  if (!parsed || typeof parsed !== 'object') throw new Error(`--config ${file}: expected a JSON object`);
  return parsed;
}

/** Resolve settings with precedence flag > env > default. Throws on invalid input so the CLI fails fast. */
export function resolveSettings(env: NodeJS.ProcessEnv, flags: CliFlags = {}): Settings {
  const username = firstEnv(env, ['OXY_HB_USERNAME']);
  const password = firstEnv(env, ['OXY_HB_PASSWORD']);
  const authModeRaw = (env.HB_AUTH_MODE ?? 'header').toLowerCase();
  if (authModeRaw !== 'header' && authModeRaw !== 'url') throw new Error(`HB_AUTH_MODE must be "header" or "url", got "${authModeRaw}"`);

  const defaultParams = paramsFromQueryString(flags.defaultParams ?? env.HB_DEFAULT_PARAMS ?? '');

  const connect = {
    timeoutMs: flags.connectTimeout ?? intEnv(env, 'HB_CONNECT_TIMEOUT_MS', 30000),
    attempts: intEnv(env, 'HB_CONNECT_ATTEMPTS', 6),
    budgetMs: intEnv(env, 'HB_CONNECT_BUDGET_MS', 120000),
  };

  const maxSessions = intEnv(env, 'HB_MAX_SESSIONS', 5);
  if (maxSessions < 1) throw new Error('HB_MAX_SESSIONS must be at least 1');

  const user = loadUserConfig(flags.config ?? env.HB_PLAYWRIGHT_CONFIG);
  const caps = parseCaps(flags.caps ?? env.HB_CAPS) ;
  const outputDir = flags.outputDir ?? env.HB_OUTPUT_DIR ?? user.outputDir;

  const { browser: userBrowser, ...userRest } = user;
  const browser: NonNullable<Config['browser']> = { ...(userBrowser ?? {}) };
  delete browser.cdpEndpoint;
  delete browser.cdpHeaders;
  delete browser.remoteEndpoint;
  delete browser.userDataDir;
  delete browser.launchOptions;
  delete browser.initScript;
  delete browser.initPage;
  delete browser.contextOptions;
  browser.browserName = 'chromium';
  browser.isolated = false;

  const playwright: Config = {
    ...userRest,
    browser,
    extension: false,
    sharedBrowserContext: false,
    server: undefined,
    capabilities: caps,
    outputDir,
    timeouts: {
      navigation: 60000,
      ...(userRest.timeouts ?? {}),
      ...(flags.timeoutAction !== undefined ? { action: flags.timeoutAction } : {}),
      ...(flags.timeoutNavigation !== undefined ? { navigation: flags.timeoutNavigation } : {}),
    },
    secrets: { ...(userRest.secrets ?? {}), ...(password ? { OXY_HB_PASSWORD: password } : {}) },
  };

  return {
    username,
    password,
    authMode: authModeRaw,
    defaultParams,
    connect,
    maxSessions,
    playwright,
    port: flags.port,
    host: flags.host ?? '127.0.0.1',
  };
}

/** Settings as printed by `--check`: password masked, secrets hidden. */
export function describeSettings(s: Settings): Record<string, unknown> {
  const { secrets, ...pw } = s.playwright;
  return {
    username: s.username ?? '(unset)',
    password: s.password ? `${'*'.repeat(Math.min(8, s.password.length))} (${s.password.length} chars)` : '(unset)',
    endpoint: HB_ENDPOINT,
    dashboardUrl: HB_DASHBOARD_URL,
    authMode: s.authMode,
    defaultParams: s.defaultParams,
    connect: s.connect,
    maxSessions: s.maxSessions,
    playwright: { ...pw, secrets: Object.keys(secrets ?? {}) },
    transport: s.port ? { port: s.port, host: s.host } : 'stdio',
  };
}
