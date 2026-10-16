// Dashboard API tools: list/stop live sessions, list/url/delete recordings, list/delete profiles, each
// merged with the account limits and mapped back to this server's session labels where applicable.

import { z } from 'zod';
import { DashboardError, describeLimits, type Limits } from '../../hb/dashboard.js';
import { requireCredentials } from '../../hb/session.js';
import { defineTool, textResult, type ToolContext } from './index.js';

const paging = {
  page: z.number().int().min(1).optional().describe('Page number, starting at 1.'),
  page_size: z.number().int().min(1).max(100).optional().describe('Items per page (default 20).'),
};

const ms = (v: number | null | undefined) => (typeof v === 'number' && v > 0 ? new Date(v).toISOString() : undefined);

async function limitsOrNull(fn: () => Promise<Limits>): Promise<Limits | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

async function deleteMany(ids: string[], one: (id: string) => Promise<void>, bulk: (ids: string[]) => Promise<void>): Promise<{ deleted: string[]; errors: Record<string, string> }> {
  const deleted: string[] = [];
  const errors: Record<string, string> = {};
  if (ids.length === 1) {
    try {
      await one(ids[0]);
      deleted.push(ids[0]);
    } catch (e) {
      errors[ids[0]] = e instanceof Error ? e.message : String(e);
    }
    return { deleted, errors };
  }
  try {
    await bulk(ids);
    deleted.push(...ids);
  } catch (e) {
    // Bulk delete is all-or-nothing; fall back to one at a time so one locked item cannot block the rest.
    if (!(e instanceof DashboardError)) throw e;
    for (const id of ids) {
      try {
        await one(id);
        deleted.push(id);
      } catch (err) {
        errors[id] = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return { deleted, errors };
}

/** Map a dashboard session id to the label of one of our open sessions, if it is ours. */
function ourLabel(ctx: ToolContext, id: string): string | undefined {
  return ctx.hub.list().find((s) => s.session.current()?.sessionId === id)?.label;
}

export const hbSessionsList = defineTool({
  name: 'hb_sessions_list',
  description: 'List the live Oxylabs Agent Browser sessions of this account (dashboard API) with the concurrency limit. Use it to find sessions that were never closed and still hold a slot.',
  input: z.object(paging),
  annotations: { title: 'List HB sessions', readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    requireCredentials(ctx.settings);
    const [list, limits] = await Promise.all([ctx.dashboard.listSessions(args.page ?? 1, args.page_size ?? 20), limitsOrNull(() => ctx.dashboard.sessionLimits())]);
    const items = list.items.map((s) => ({ ...s, created_at: ms(s.created_at), expires_at: ms(s.expires_at), label: ourLabel(ctx, s.id), is_ours: ourLabel(ctx, s.id) !== undefined }));
    return textResult(`${list.total} live session(s)${limits ? `; concurrency ${describeLimits(limits)}` : ''}.`, { ...list, items, limits });
  },
});

export const hbSessionStop = defineTool({
  name: 'hb_session_stop',
  description: 'Stop a live session of this account by id (from hb_sessions_list). Stopping one of this server\'s own sessions also closes it here.',
  input: z.object({ id: z.string().min(1).describe('Session id.') }),
  annotations: { title: 'Stop HB session', destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    requireCredentials(ctx.settings);
    const label = ourLabel(ctx, args.id);
    await ctx.dashboard.stopSession(args.id);
    if (label) await ctx.hub.close(label, 'hb_session_stop');
    return textResult(`Stop requested for session ${args.id}${label ? ` (it was our session "${label}"; closed)` : ''}.`, { stopped: args.id, label });
  },
});

export const hbRecordingsList = defineTool({
  name: 'hb_recordings_list',
  description: 'List session recordings (videos of sessions started with record=true) with the recording limit. Newest first.',
  input: z.object(paging),
  annotations: { title: 'List recordings', readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    requireCredentials(ctx.settings);
    const [list, limits] = await Promise.all([ctx.dashboard.listRecordings(args.page ?? 1, args.page_size ?? 20), limitsOrNull(() => ctx.dashboard.recordingLimits())]);
    const items = list.items.map((r) => ({ ...r, created_at: ms(r.created_at), expires_at: ms(r.expires_at) }));
    return textResult(`${list.total} recording(s)${limits ? `; ${describeLimits(limits)}` : ''}. Use hb_recording_url to get a playback link.`, { ...list, items, limits });
  },
});

export const hbRecordingUrl = defineTool({
  name: 'hb_recording_url',
  description: 'Get a temporary playback/download URL (MP4) for a recording id from hb_recordings_list.',
  input: z.object({ id: z.string().min(1).describe('Recording id.') }),
  annotations: { title: 'Recording URL', readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    requireCredentials(ctx.settings);
    const res = await ctx.dashboard.recordingUrl(args.id);
    return textResult(`Playback URL (valid until ${ms(res.expires_at) ?? 'unknown'}): ${res.url}`, { ...res, expires_at: ms(res.expires_at) });
  },
});

export const hbRecordingDelete = defineTool({
  name: 'hb_recording_delete',
  description: 'Delete one or more recordings by id (frees the recording quota).',
  input: z.object({ ids: z.array(z.string().min(1)).min(1).describe('Recording ids from hb_recordings_list.') }),
  annotations: { title: 'Delete recordings', destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    requireCredentials(ctx.settings);
    const out = await deleteMany(args.ids, (id) => ctx.dashboard.deleteRecording(id), (ids) => ctx.dashboard.deleteRecordings(ids));
    const failed = Object.keys(out.errors).length;
    return textResult(`Deleted ${out.deleted.length} recording(s)${failed ? `, ${failed} failed` : ''}.`, out, failed > 0 && out.deleted.length === 0);
  },
});

export const hbProfilesList = defineTool({
  name: 'hb_profiles_list',
  description: 'List stored browser profiles (created by sessions with o_profile + o_profile_save=true) with the profile limit. A profile is addressed by its id in hb_profile_delete and by its name in hb_connect(o_profile).',
  input: z.object(paging),
  annotations: { title: 'List profiles', readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    requireCredentials(ctx.settings);
    const [list, limits] = await Promise.all([ctx.dashboard.listProfiles(args.page ?? 1, args.page_size ?? 20), limitsOrNull(() => ctx.dashboard.profileLimits())]);
    const items = list.items.map((p) => ({ ...p, created_at: ms(p.created_at), modified_at: ms(p.modified_at), expires_at: ms(p.expires_at) }));
    return textResult(`${list.total} profile(s)${limits ? `; ${describeLimits(limits)}` : ''}.`, { ...list, items, limits });
  },
});

export const hbProfileDelete = defineTool({
  name: 'hb_profile_delete',
  description: 'Delete one or more stored profiles by id (from hb_profiles_list). A profile locked by a live session that is saving it returns 409; wait for that session to end.',
  input: z.object({ ids: z.array(z.string().min(1)).min(1).describe('Profile ids from hb_profiles_list.') }),
  annotations: { title: 'Delete profiles', destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    requireCredentials(ctx.settings);
    const out = await deleteMany(args.ids, (id) => ctx.dashboard.deleteProfile(id), (ids) => ctx.dashboard.deleteProfiles(ids));
    const failed = Object.keys(out.errors).length;
    return textResult(`Deleted ${out.deleted.length} profile(s)${failed ? `, ${failed} failed` : ''}.`, out, failed > 0 && out.deleted.length === 0);
  },
});
