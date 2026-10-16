// Generic retry helper with exponential backoff, full jitter, an attempt limit and an overall time budget,
// used for the HB websocket handshake.

export interface BackoffOptions {
  attempts?: number;
  baseMs?: number;
  capMs?: number;
  budgetMs?: number;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export const DEFAULT_BACKOFF = { attempts: 6, baseMs: 1000, capMs: 60000, budgetMs: 120000 };

export function backoffDelay(attempt: number, baseMs: number, capMs: number, random: () => number): number {
  return Math.min(capMs, baseMs * 2 ** attempt) * (0.5 + random() * 0.5);
}

export class BackoffExhausted extends Error {
  constructor(
    readonly cause: unknown,
    readonly attempts: number,
    readonly budgetHit: boolean,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'BackoffExhausted';
  }
}

/** Retry `fn` on retryable errors with exponential backoff (full jitter) and an overall time budget. */
export async function withBackoff<T>(fn: (attempt: number) => Promise<T>, options: BackoffOptions = {}): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_BACKOFF.attempts;
  const baseMs = options.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const capMs = options.capMs ?? DEFAULT_BACKOFF.capMs;
  const budgetMs = options.budgetMs ?? DEFAULT_BACKOFF.budgetMs;
  const isRetryable = options.isRetryable ?? (() => true);
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = Date.now();

  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.signal?.aborted) throw new BackoffExhausted(lastErr ?? new Error('aborted'), attempt, false);
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      const delay = backoffDelay(attempt, baseMs, capMs, random);
      const elapsed = Date.now() - startedAt;
      if (attempt === attempts - 1) break;
      if (elapsed + delay > budgetMs) throw new BackoffExhausted(err, attempt + 1, true);
      options.onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
    }
  }
  throw new BackoffExhausted(lastErr, attempts, false);
}
