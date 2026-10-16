// Session lifecycle tools: hb_connect (open a labelled session with validated public parameters),
// hb_disconnect (close one or all) and hb_session_info (list sessions, detail one).

import { z } from 'zod';
import { HbParamsShape, mergeParams } from '../../hb/params.js';
import { MAX_SESSION_MS } from '../../hb/session.js';
import { LABEL_RE } from '../hub.js';
import { defineTool, SESSION_ARG_DESCRIPTION, textResult } from './index.js';

const labelArg = z
  .string()
  .regex(LABEL_RE, 'label must be 1-32 characters of letters, digits, "_" or "-"')
  .optional()
  .describe('Name for this session, e.g. "de" or "kr", used as the `session` argument of browser_* tools. Reusing a label replaces that session. Default: auto (s1, s2, ...).');

export const hbConnect = defineTool({
  name: 'hb_connect',
  description:
    'Open an Oxylabs Agent Browser session (one identity: geo, device configuration, proxy, profile) and return its label, which every browser_* and hb_* tool then takes as `session`. Several sessions can be open at once, e.g. label="de" with p_cc=DE and label="kr" with p_cc=KR, and they run in parallel. Parameters merge over the server defaults (HB_DEFAULT_PARAMS) unless replace_defaults=true. Most jobs need only p_cc. Always call this first.',
  input: z.looseObject({
    label: labelArg,
    ...HbParamsShape,
    replace_defaults: z.boolean().optional().describe('Ignore HB_DEFAULT_PARAMS and use exactly the parameters given here.'),
  }),
  annotations: { title: 'Connect to HB', destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const { label, replace_defaults, ...raw } = args as Record<string, unknown> & { label?: string; replace_defaults?: boolean };
    const params = mergeParams(ctx.settings.defaultParams, raw, replace_defaults === true);
    const info = await ctx.hub.connect(label, params);
    const lines = [
      `Connected: HB session "${info.label}" (id \`${info.session_id}\`). Pass session="${info.label}" to every browser_* call.`,
      `Live view: ${info.live_url}`,
      `Expires at ${info.expires_at} (1 h cap). browser_close(session="${info.label}") or hb_disconnect(session="${info.label}") ends it.`,
      `Open sessions: ${info.open_sessions.join(', ')}.`,
      ...info.notes.map((n) => `- ${n}`),
    ];
    return textResult(lines.join('\n'), info);
  },
});

export const hbDisconnect = defineTool({
  name: 'hb_disconnect',
  description:
    'Close an Oxylabs Agent Browser session (or all of them) and free its concurrency slot. Open pages and cookies are discarded; a session opened with session_name stays resumable for 10 minutes; a profile opened with o_profile_save=true is written now; a recording is finalised now.',
  input: z.object({
    session: z.string().optional().describe(`${SESSION_ARG_DESCRIPTION} Required unless all=true.`),
    all: z.boolean().optional().describe('Close every open session.'),
  }),
  annotations: { title: 'Disconnect from HB', destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.all) {
      const closed = await ctx.hub.closeAll('hb_disconnect all');
      return textResult(closed.length ? `Closed ${closed.length} HB session(s): ${closed.map((c) => c.label).join(', ')}.` : 'No HB session was open.', closed);
    }
    if (args.session === undefined) return textResult('Pass session=<label> (see hb_session_info) or all=true.', undefined, true);
    const info = await ctx.hub.close(args.session, 'hb_disconnect');
    const lines = [`HB session "${info.label}"${info.session_id ? ` (id \`${info.session_id}\`)` : ''} closed.`];
    if (info.session_name) lines.push(`Named session "${info.session_name}" can be resumed within 10 minutes with hb_connect(session_name="${info.session_name}") and the same other parameters.`);
    if (info.profile_saved) lines.push(`Profile "${info.profile_saved}" is being saved (appears in hb_profiles_list shortly).`);
    if (info.recorded) lines.push('The recording is being finalised (see hb_recordings_list).');
    lines.push(ctx.hub.labels().length ? `Open sessions: ${ctx.hub.describeLabels()}.` : 'No sessions remain open.');
    return textResult(lines.join('\n'), { ...info, open_sessions: ctx.hub.labels() });
  },
});

export const hbSessionInfo = defineTool({
  name: 'hb_session_info',
  description:
    'List the open Oxylabs Agent Browser sessions (label, id, geo/params, time left of the 1-hour cap, tabs). With `session`, also describe that one in detail: live-view URL, tabs with their last main-frame status, recent challenge handling events and Oxylabs network errors (X-Error-Description responses).',
  input: z.object({ session: z.string().optional().describe(`${SESSION_ARG_DESCRIPTION} Omit to list all sessions.`) }),
  annotations: { title: 'HB session info', readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const sessions = ctx.hub.list().map((s) => s.session.summary());
    if (!sessions.length) {
      return textResult('No HB session is open. Call hb_connect first.', {
        sessions: [],
        default_params: ctx.settings.defaultParams,
        max_sessions: ctx.settings.maxSessions,
      });
    }
    if (args.session === undefined) {
      return textResult(`${sessions.length} open session(s): ${ctx.hub.describeLabels()}. Pass session=<label> for details.`, { sessions, max_sessions: ctx.settings.maxSessions });
    }
    const slot = ctx.hub.get(args.session);
    const session = slot.session;
    const s = session.current();
    const now = Date.now();
    const detail = s
      ? {
          label: slot.label,
          connected: true,
          session_id: s.sessionId,
          live_url: s.liveUrl,
          params: s.params,
          connected_at: new Date(s.connectedAt).toISOString(),
          elapsed_s: Math.round((now - s.connectedAt) / 1000),
          remaining_s: Math.max(0, Math.round((s.connectedAt + MAX_SESSION_MS - now) / 1000)),
          tabs: s.context.pages().map((p, index) => {
            const main = session.mainResponse(p);
            return { index, url: p.url(), last_main_status: main?.status, last_main_url: main?.url };
          }),
          page_states: session.pageState.recent(10).map((e) => ({ at: new Date(e.at).toISOString(), status: e.status, reason: e.reason, page_url: e.pageUrl })),
          oxylabs_network_errors: session.netErrors.slice(-10).map((e) => ({ at: new Date(e.at).toISOString(), status: e.status, url: e.url, description: e.description })),
          last_navigation_error: session.lastNavError ? { at: new Date(session.lastNavError.at).toISOString(), text: session.lastNavError.text } : undefined,
        }
      : { label: slot.label, connected: false, params: session.params, note: 'not connected yet; the next browser_* call on it connects' };
    const head = s
      ? `Session "${slot.label}" (id \`${s.sessionId}\`), ${detail.remaining_s} s left of the 1 h cap, ${s.context.pages().length} tab(s). Live view: ${s.liveUrl}`
      : `Session "${slot.label}" is not connected yet.`;
    return textResult(`${head}\nOpen sessions: ${ctx.hub.describeLabels()}.`, { sessions, detail });
  },
});
