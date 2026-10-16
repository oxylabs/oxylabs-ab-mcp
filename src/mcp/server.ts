// The composite MCP server: lists the proxied Playwright tools (each with a required `session` argument) plus
// the hb_* tools, routes tools/call to the right session's Playwright backend or hb_* handler, redacts every
// result, intercepts browser_close to end the HB session, and serves the hb://reference/* resources.

import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { DashboardClient } from '../hb/dashboard.js';
import { ParamsError } from '../hb/params.js';
import { requireCredentials, type ConnectOverCDP } from '../hb/session.js';
import { HB_DASHBOARD_URL } from '../hb/url.js';
import { Redactor } from '../redact.js';
import type { Settings } from '../settings.js';
import { HIDDEN_TOOLS } from './bridge.js';
import { NoSessionError, SessionHub } from './hub.js';
import { HB_TOOLS } from './tools/all.js';
import { errorResult, SESSION_ARG_DESCRIPTION, type HbTool, type ToolContext } from './tools/index.js';
import { readReference, REFERENCE_TOPICS } from './tools/reference.js';

export const SERVER_NAME = 'oxylabs-ab-mcp';
import { SERVER_VERSION } from './version.js';
export { SERVER_VERSION };

export interface HbServer {
  server: Server;
  hub: SessionHub;
  dashboard: DashboardClient;
  shutdown: () => Promise<void>;
}

export interface BuildOptions {
  referenceDir: string;
  log?: (message: string) => void;
  /** Test hook: replaces playwright's connectOverCDP. */
  connectOverCDP?: ConnectOverCDP;
}

function toMcpTool(t: HbTool): Tool {
  return {
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Tool['inputSchema'],
    annotations: t.annotations,
  };
}

/** Every proxied Playwright tool gains a required `session` argument naming the HB session it acts on. */
function withSessionArg(tool: Tool): Tool {
  const schema = tool.inputSchema as { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: { session: { type: 'string', description: SESSION_ARG_DESCRIPTION }, ...(schema.properties ?? {}) },
      required: ['session', ...(schema.required ?? []).filter((r) => r !== 'session')],
    },
  };
}

function appendText(result: CallToolResult, text: string): CallToolResult {
  const content = [...result.content];
  const lastText = [...content].reverse().find((c) => c.type === 'text');
  if (lastText && lastText.type === 'text') {
    const idx = content.lastIndexOf(lastText);
    content[idx] = { ...lastText, text: `${lastText.text}\n${text}` };
  } else {
    content.push({ type: 'text', text });
  }
  return { ...result, content };
}

/** Compose the Playwright MCP tools (proxied per HB session) with the hb_* tools into one MCP server. */
export async function buildServer(settings: Settings, opts: BuildOptions): Promise<HbServer> {
  const log = opts.log ?? (() => undefined);
  const redactor = new Redactor([{ name: 'OXY_AB_PASSWORD', value: settings.password, username: settings.username }]);
  const safeLog = (m: string) => log(redactor.text(m));
  const hub = await SessionHub.create(settings, redactor, safeLog, opts.connectOverCDP);
  const dashboard = new DashboardClient(HB_DASHBOARD_URL, () => requireCredentials(settings), redactor);
  const ctx: ToolContext = { settings, hub, dashboard, redactor, referenceDir: opts.referenceDir, log: safeLog };
  const hbByName = new Map(HB_TOOLS.map((t) => [t.name, t]));
  const bridgedTools = hub.tools.map(withSessionArg);
  const bridgedNames = new Set(bridgedTools.map((t) => t.name));

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: [
        'This server drives remote Oxylabs Agent Browser sessions (managed browser environment, residential proxies, geo-targeting) through the standard Playwright MCP tools.',
        'Start with hb_connect (parameters such as p_cc, p_device, p_src, p_fp_tag, session_name, o_profile, record, page_handler; most jobs need only p_cc). It returns a session label; every browser_* and hb_* tool takes that label as its `session` argument.',
        'Several sessions can be open at once (hb_connect with a label per identity, e.g. "de" and "kr") and run in parallel. Run independent identities in parallel sessions, not in tabs of one session.',
        'Never set the viewport or device metrics; the service owns the browser configuration. Use the default context only.',
        'Sessions live at most 1 hour and hold a concurrency slot until closed: finish each with browser_close or hb_disconnect (all=true closes everything).',
        'When a page looks blocked, run hb_classify_page before retrying; it distinguishes Oxylabs network errors (retry), supported challenges (challenge handling), hard blocks (fresh identity, then the new engine: p_src=oxybrowser with p_fp_tag=oxyfp_mac_optimized) and restricted targets (stop).',
        'Parameter and error details: hb_reference.',
      ].join(' '),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...bridgedTools, ...HB_TOOLS.map(toMcpTool)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const hb = hbByName.get(name);
      if (hb) {
        const parsed = hb.input.safeParse(args);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
          return errorResult(`Invalid arguments for ${name}: ${issues}`);
        }
        return redactor.result(await hb.handler(parsed.data, ctx, extra.signal));
      }
      const hiddenReason = HIDDEN_TOOLS.get(name);
      if (hiddenReason) return errorResult(`${name} is not available: ${hiddenReason}`);
      if (!bridgedNames.has(name)) return errorResult(`Tool "${name}" not found`);

      const { session: rawLabel, ...rest } = args;
      if (typeof rawLabel !== 'string' || !rawLabel) {
        return errorResult(`${name} requires session=<label> (from hb_connect). Open sessions: ${hub.describeLabels()}.`);
      }
      const slot = hub.get(rawLabel);
      let result = await hub.callTool(slot, name, rest, extra.signal);
      if (name === 'browser_close') {
        const closed = await hub.close(slot.label, 'browser_close').catch(() => undefined);
        const remaining = hub.labels();
        result = appendText(
          result,
          closed?.session_id
            ? `HB session "${closed.label}" (${closed.session_id}) ended.${closed.session_name ? ` Named session "${closed.session_name}" is resumable for 10 min via hb_connect.` : ''}${closed.profile_saved ? ` Profile "${closed.profile_saved}" is being saved.` : ''}${remaining.length ? ` Open sessions: ${remaining.join(', ')}.` : ' No sessions remain open.'}`
            : `HB session "${slot.label}" closed (it was not connected).`,
        );
      } else if (name === 'browser_navigate') {
        slot.session.noteNavigationResult(result);
      }
      return redactor.result(result);
    } catch (err) {
      if (err instanceof ParamsError) return errorResult(`Invalid HB parameters: ${err.message}. See hb_reference(topic="params").`);
      if (err instanceof NoSessionError) return errorResult(err.message);
      return errorResult(redactor.error(err));
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: REFERENCE_TOPICS.map((t) => ({
      uri: `hb://reference/${t}`,
      name: `Oxylabs Agent Browser reference: ${t}`,
      mimeType: 'text/markdown',
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const m = /^hb:\/\/reference\/([a-z]+)$/.exec(req.params.uri);
    const topic = m?.[1] as (typeof REFERENCE_TOPICS)[number] | undefined;
    if (!topic || !REFERENCE_TOPICS.includes(topic)) throw new Error(`Unknown resource ${req.params.uri}`);
    return { contents: [{ uri: req.params.uri, mimeType: 'text/markdown', text: await readReference(opts.referenceDir, topic) }] };
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await hub.shutdown();
  };

  return { server, hub, dashboard, shutdown };
}
