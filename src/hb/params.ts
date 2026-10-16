// The public HB connection parameters as a zod schema: per-parameter formats, combination rules, normalisation,
// rejection of internal-only parameters, merging call arguments over env defaults, parsing HB_DEFAULT_PARAMS
// and producing the sorted query string sent to the gateway.

import { z } from 'zod';

/** Parameters the service understands but that are not part of the public contract. Rejected by name. */
export const INTERNAL_PARAMS = new Set([
  'p_fp_id',
  'user-agent',
  'o_pw',
  'o_skip_init_js',
  'p_no_proxy',
  'proxy_override',
  'o_proxy',
  'o_dc',
  'o_humanize',
  'o_humanize_min',
  'o_humanize_max',
  'bargs',
  'o_vnc',
]);

const GEO_PARAMS = ['p_cc', 'p_state', 'p_city', 'proxy_resi_ses_id', 'proxy_resi_ses_time'] as const;

/** Public browser engines (`p_src`). Omitted = the default engine. */
export const BROWSER_ENGINES = ['oxybrowser'] as const;

/** Public desktop browser profile families (`p_fp_tag`). Omitted = `oxyfp_win`. */
export const BROWSER_PROFILE_TAGS = ['oxyfp_win', 'oxyfp_mac', 'oxyfp_mac_optimized', 'oxyfp_v1_win'] as const;

export const HbParamsShape = {
    session_name: z
      .string()
      .regex(/^[A-Za-z0-9-]{3,36}$/, "session_name must be 3-36 alphanumeric or '-' characters")
      .optional()
      .describe(
        'Names the session so it can be resumed by reconnecting with the same name within 10 minutes of a disconnect. Implies keep_alive=true. Default cap: 5 named sessions.',
      ),
    keep_alive: z
      .boolean()
      .optional()
      .describe('Keep the remote browser alive after disconnect. Requires session_name. Set false with a name to make the named session non-resumable.'),
    proxy: z
      .enum(['resi', 'dc'])
      .optional()
      .describe('Proxy type: residential (default) or datacenter. dc does not accept p_cc/p_state/p_city/proxy_resi_ses_*.'),
    p_cc: z
      .string()
      .regex(/^[A-Za-z]{2}$/, 'invalid p_cc, supported ISO-3166 2 letter codes')
      .transform((s) => s.toUpperCase())
      .optional()
      .describe('Exit country, ISO-3166 alpha-2 (US, DE). Most jobs need only this.'),
    p_state: z
      .string()
      .transform((s) => s.trim().toLowerCase().replace(/\s+/g, '_'))
      .pipe(z.string().regex(/^[a-z_]{2,40}$/, 'p_state must be a lowercase US state name, e.g. texas or us_texas'))
      .optional()
      .describe('US state (texas or us_texas). Overrides p_cc.'),
    p_city: z
      .string()
      .transform((s) => s.trim().toLowerCase().replace(/\s+/g, '_'))
      .pipe(z.string().regex(/^[a-z0-9_]{1,64}$/, 'p_city must be lowercase letters, digits and underscores'))
      .optional()
      .describe('City preference (los_angeles), best effort. Requires p_cc or p_state.'),
    proxy_resi_ses_id: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_]{2,35}$/, 'proxy_resi_ses_id must be 3-36 alphanumeric characters or underscores')
      .optional()
      .describe('Sticky residential session id: identical values keep the same exit IP across connections. Disables automatic proxy retry. Residential only.'),
    proxy_resi_ses_time: z
      .number()
      .int()
      .min(1, 'proxy_resi_ses_time must be between 1 and 1440')
      .max(1440, 'proxy_resi_ses_time must be between 1 and 1440')
      .optional()
      .describe('Minutes the sticky IP is held (1-1440). Residential only.'),
    p_device: z
      .enum(['desktop', 'mobile'])
      .optional()
      .describe('Device profile (browser configuration, viewport, UA, proxy pool). Default desktop. Never set the viewport yourself; the service owns it.'),
    p_src: z
      .enum(BROWSER_ENGINES)
      .optional()
      .describe('Browser engine. Omitted = the default engine. oxybrowser = the new engine: the escalation step when a fresh identity with the right geo is still blocked; pair it with p_fp_tag=oxyfp_mac_optimized. Keep it identical for every connection to a target once it works.'),
    p_fp_tag: z
      .enum(BROWSER_PROFILE_TAGS)
      .optional()
      .describe('Desktop browser profile family (the OS the browser configuration presents). Default oxyfp_win (Windows). oxyfp_mac = macOS. oxyfp_mac_optimized = macOS tuned for p_src=oxybrowser (only valid with it). oxyfp_v1_win = previous Windows family, kept for backward compatibility. Not for p_device=mobile.'),
    o_profile: z
      .string()
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,35}$/,
        'o_profile must contain only letters, numbers, hyphens, and underscores (min 3, max 36 characters)',
      )
      .optional()
      .describe('Persistent profile name: restores cookies/localStorage saved under this name. Missing profile is created empty. Retained 14 days from last use.'),
    o_profile_save: z
      .boolean()
      .optional()
      .describe('Persist the profile when the session ends. Requires o_profile. Send from exactly one setup run per profile; consumers use o_profile alone.'),
    record: z.boolean().optional().describe('Record the session to video (viewable via hb_recordings_list / dashboard). Default cap 10 recordings.'),
    record_name: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/, 'record_name must contain only letters, numbers, hyphens, and underscores (max 64 characters)')
      .optional()
      .describe('Label for the recording. Requires record=true.'),
    page_handler: z
      .boolean()
      .optional()
      .describe('Enable the in-browser page handler: it identifies every page, completes the access challenges it finds and reports the page state (oxylabs-page-status). Absent = the account setting applies (handling may be on), so always pass it explicitly. Start with false; enable on a fresh connection after the plain attempt shows a block or verification page.'),
};

export const HbParamsSchema = z
  .object(HbParamsShape)
  .strict()
  .superRefine((p, ctx) => {
    if (p.keep_alive !== undefined && !p.session_name) {
      ctx.addIssue({ code: 'custom', path: ['keep_alive'], message: 'keep_alive requires session_name' });
    }
    if (p.proxy === 'dc') {
      const bad = GEO_PARAMS.filter((k) => p[k] !== undefined);
      if (bad.length) {
        ctx.addIssue({ code: 'custom', path: ['proxy'], message: `proxy=dc does not support [${bad.join(' ')}] params` });
      }
    }
    if (p.p_city && !p.p_cc && !p.p_state) {
      ctx.addIssue({ code: 'custom', path: ['p_city'], message: 'p_city requires p_cc or p_state' });
    }
    if (p.o_profile_save !== undefined && !p.o_profile) {
      ctx.addIssue({ code: 'custom', path: ['o_profile_save'], message: 'o_profile_save requires o_profile to be set' });
    }
    if (p.record_name !== undefined && p.record !== true) {
      ctx.addIssue({ code: 'custom', path: ['record_name'], message: 'record_name requires record=true' });
    }
    if (p.p_fp_tag === 'oxyfp_mac_optimized' && p.p_src !== 'oxybrowser') {
      ctx.addIssue({ code: 'custom', path: ['p_fp_tag'], message: 'p_fp_tag=oxyfp_mac_optimized requires p_src=oxybrowser' });
    }
    if (p.p_fp_tag !== undefined && p.p_device === 'mobile') {
      ctx.addIssue({ code: 'custom', path: ['p_fp_tag'], message: 'p_fp_tag selects a desktop profile family; drop it for p_device=mobile' });
    }
  });

export type HbParams = z.output<typeof HbParamsSchema>;
export type HbParamsInput = z.input<typeof HbParamsSchema>;

export class ParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParamsError';
  }
}

/** Validate a raw params object. Throws ParamsError with all problems joined by "; ". */
export function validateParams(input: Record<string, unknown>): HbParams {
  const raw = input;
  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    if (INTERNAL_PARAMS.has(key)) {
      problems.push(`${key} is not a public parameter and cannot be set through oxylabs-ab-mcp`);
    }
  }
  if (problems.length) throw new ParamsError(problems.join('; '));

  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) clean[k] = v;
  }
  const result = HbParamsSchema.safeParse(clean);
  if (!result.success) {
    for (const issue of result.error.issues) {
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) problems.push(`unknown parameter ${key}; see hb_reference(topic="params")`);
      } else {
        const where = issue.path.length ? String(issue.path[0]) : '';
        const msg = issue.message;
        problems.push(msg.startsWith(where) || !where ? msg : `${where}: ${msg}`);
      }
    }
    throw new ParamsError(problems.join('; '));
  }
  return result.data;
}

/** Merge env defaults with call arguments, then validate the merged set (combination rules apply post-merge). */
export function mergeParams(defaults: HbParams, args: Record<string, unknown>, replaceDefaults = false): HbParams {
  const given = args;
  const merged = replaceDefaults ? { ...given } : { ...defaults, ...given };
  return validateParams(merged);
}

/** Coerce values from a query string (`HB_DEFAULT_PARAMS`) to the typed shape. */
export function paramsFromQueryString(query: string): HbParams {
  const raw: Record<string, unknown> = {};
  const usp = new URLSearchParams(query.replace(/^\?/, ''));
  for (const [k, v] of usp) {
    raw[k] = coerceQueryValue(k, v);
  }
  return validateParams(raw);
}

function coerceQueryValue(key: string, value: string): unknown {
  const lower = value.toLowerCase();
  if (['keep_alive', 'o_profile_save', 'record', 'page_handler'].includes(key)) {
    if (['true', '1', 'on', 'yes'].includes(lower)) return true;
    if (['false', '0', 'off', 'no'].includes(lower)) return false;
    return value;
  }
  if (key === 'proxy_resi_ses_time') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

/** Deterministic query string: sorted keys so the parameter set (and the service's pool key) stays stable. */
export function toQueryString(params: HbParams): string {
  const usp = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const value = (params as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    usp.set(key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
  }
  return usp.toString();
}
