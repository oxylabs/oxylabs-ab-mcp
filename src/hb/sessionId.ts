// Fetches the gateway's session id through the custom CDP method `__session_id`.

import type { BrowserContext, Page } from 'playwright-core';

/** The gateway answers the custom CDP method `__session_id` on any page session with `{ value }`. */
export async function getSessionId(context: BrowserContext, page: Page): Promise<string> {
  const cdp = await context.newCDPSession(page);
  try {
    const res = (await cdp.send('__session_id' as never)) as { value?: string } | undefined;
    if (!res || typeof res.value !== 'string' || res.value.length === 0) {
      throw new Error('gateway returned no session id for __session_id');
    }
    return res.value;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}
