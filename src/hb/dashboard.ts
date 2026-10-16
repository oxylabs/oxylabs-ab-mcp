// Client for the HB dashboard JSON API (sessions, recordings, profiles) with HTTP Basic auth, a per-process
// request gate for the 10 req/s user rate limit, 429 retries and explained error messages.

import type { Redactor } from '../redact.js';
import { buildAuthHeader } from './url.js';

export interface Paged<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  limit?: number;
}

export interface Limits {
  used: number;
  limit: number;
}

export interface ActiveSession {
  id: string;
  created_at: number;
  expires_at: number;
  width: number;
  height: number;
  live_url: string;
}

export interface RecordingItem {
  id: string;
  filename: string;
  size: number;
  created_at?: number | null;
  duration_ms?: number | null;
  width?: number | null;
  height?: number | null;
  expires_at?: number | null;
}

export interface ProfileItem {
  id: string;
  name: string;
  browser: string;
  size: number;
  created_at?: number;
  modified_at?: number;
  expires_at?: number | null;
}

export class DashboardError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'DashboardError';
  }
}

export interface DashboardOptions {
  minGapMs?: number;
  retries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Thin client for the HB dashboard JSON API (HTTP Basic, per-user rate limit of 10 req/s). */
export class DashboardClient {
  private gate: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private readonly minGapMs: number;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly credentials: (() => { username: string; password: string }) | { username: string; password: string },
    private readonly redactor: Redactor,
    opts: DashboardOptions = {},
  ) {
    this.minGapMs = opts.minGapMs ?? 120;
    this.retries = opts.retries ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const creds = typeof this.credentials === 'function' ? this.credentials() : this.credentials;
    const auth = buildAuthHeader(creds.username, creds.password);
    for (let attempt = 0; ; attempt++) {
      const res = await this.throttled(() =>
        this.fetchImpl(this.url(path), {
          ...init,
          headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined), Authorization: auth },
          signal: AbortSignal.timeout(this.timeoutMs),
        }),
      );
      if (res.status === 429 && attempt < this.retries) {
        await sleep(this.minGapMs * (attempt + 1) * 2);
        continue;
      }
      return res;
    }
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) throw new DashboardError(res.status, this.redactor.text(errorMessage(res.status, text)), path);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DashboardError(res.status, `dashboard returned non-JSON for ${path}`, path);
    }
  }

  listSessions(page = 1, pageSize = 20): Promise<Paged<ActiveSession>> {
    return this.json(`/api/v1/sessions?page=${page}&page_size=${pageSize}`);
  }

  sessionLimits(): Promise<Limits> {
    return this.json('/api/v1/sessions/limits');
  }

  stopSession(id: string): Promise<void> {
    return this.json(`/api/v1/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' });
  }

  listRecordings(page = 1, pageSize = 20): Promise<Paged<RecordingItem>> {
    return this.json(`/api/v1/recordings?page=${page}&page_size=${pageSize}`);
  }

  recordingLimits(): Promise<Limits> {
    return this.json('/api/v1/recordings/limits');
  }

  recordingUrl(id: string): Promise<{ url: string; expires_at: number }> {
    return this.json(`/api/v1/recordings/${encodeURIComponent(id)}/url`);
  }

  deleteRecording(id: string): Promise<void> {
    return this.json(`/api/v1/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  deleteRecordings(ids: string[]): Promise<void> {
    return this.json('/api/v1/recordings/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
  }

  listProfiles(page = 1, pageSize = 20): Promise<Paged<ProfileItem>> {
    return this.json(`/api/v1/profiles?page=${page}&page_size=${pageSize}`);
  }

  profileLimits(): Promise<Limits> {
    return this.json('/api/v1/profiles/limits');
  }

  deleteProfile(id: string): Promise<void> {
    return this.json(`/api/v1/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  deleteProfiles(ids: string[]): Promise<void> {
    return this.json('/api/v1/profiles/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
  }

  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(async () => {
      const wait = this.lastRequestAt + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      return fn();
    });
    this.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Limits semantics from the dashboard: 0 = feature disabled, negative = unlimited. */
export function describeLimits(l: Limits): string {
  if (l.limit === 0) return `used ${l.used}; feature disabled for this account`;
  if (l.limit < 0) return `used ${l.used}; unlimited`;
  return `used ${l.used} of ${l.limit}`;
}

function errorMessage(status: number, text: string): string {
  let detail = text.trim();
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed && typeof parsed.error === 'string') detail = parsed.error;
  } catch {
    // plain text body
  }
  const hints: Record<number, string> = {
    401: 'authentication required: check OXY_HB_USERNAME / OXY_HB_PASSWORD',
    404: 'not found (or not owned by this account)',
    409: 'locked by a live session that is saving it; wait for that session to close',
    429: 'dashboard rate limit exceeded; slow down',
  };
  const hint = hints[status];
  return `dashboard ${status}: ${detail || 'error'}${hint ? ` (${hint})` : ''}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
