// hb_classify_page: gathers facts about a session's current page (last main response, title, text, child
// frames, cookies, navigation errors, the page handler's states on this page) and runs the pure classifier to
// tell block from challenge from network error, with the next step.

import { z } from 'zod';
import { classify, type PageFacts } from '../../hb/classify.js';
import { defineTool, SESSION_ARG_DESCRIPTION, textResult } from './index.js';

const SIGNATURE_SRC = /(?:src|href|action)=["']([^"']*(?:captcha-delivery\.com|challenges\.cloudflare\.com|hcaptcha\.com|recaptcha)[^"']*)["']/gi;

export const hbClassifyPage = defineTool({
  name: 'hb_classify_page',
  description:
    'Decide whether the current page is the real target, a failed navigation (retry), an Oxylabs network error (retry), an access challenge the page handler acts on (enable page_handler=true or wait for its state), a hard block it does not act on (fresh identity), a restricted target for this account, or a soft block, and say what to do next. Uses the last main-frame response, title, visible text, child frames, cookies and the page handler\'s states on this page.',
  input: z.object({
    session: z.string().min(1).describe(SESSION_ARG_DESCRIPTION),
    tab_index: z.number().int().min(0).optional().describe('Tab to inspect (browser_tabs index). Default: the most recently navigated tab.'),
  }),
  annotations: { title: 'Classify page', readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const session = ctx.hub.get(args.session).session;
    const page = session.page(args.tab_index);
    const main = session.mainResponse(page);
    const title = await page.title().catch(() => '');
    const text = await page
      .evaluate(() => {
        const d = (globalThis as unknown as { document?: { body?: { innerText?: string } } }).document;
        return d?.body?.innerText ?? '';
      })
      .catch(() => '');
    const html = await page.content().catch(() => '');
    const mainFrame = page.mainFrame();
    const frameUrls = new Set(
      page
        .frames()
        .filter((f) => f !== mainFrame)
        .map((f) => f.url())
        .filter((u) => u && u !== 'about:blank'),
    );
    for (const m of html.matchAll(SIGNATURE_SRC)) frameUrls.add(m[1]);
    const cookieNames = await page
      .context()
      .cookies(page.url().startsWith('http') ? page.url() : undefined)
      .then((cs) => cs.map((c) => c.name))
      .catch(() => [] as string[]);
    const lastNav = session.navError(page);
    // States of this page only, and for the last one only those since the current document's main response
    // (older ones describe a previous document).
    const states = session.pageState.forPage(session.pageState.pageIdOf(page));
    const current = main ? states.filter((e) => e.at >= main.at) : states;
    const lastStatus = current[current.length - 1];
    const facts: PageFacts = {
      url: page.url(),
      status: main?.status,
      headers: main?.headers,
      title,
      bodySnippet: text.slice(0, 4096),
      frameUrls: [...frameUrls],
      cookieNames,
      lastNavError: lastNav,
      lastPageState: lastStatus ? { status: lastStatus.status, reason: lastStatus.reason } : undefined,
      challengeHandled: session.challengeHandled(page) !== undefined,
    };
    const result = classify(facts);
    const data = {
      ...result,
      session: session.label,
      url: facts.url,
      status: facts.status,
      title,
      page_handler_enabled: session.params.page_handler,
      bot_management_cookies: cookieNames.filter((n) => /^(cf_clearance|datadome|_abck|bm_sz|__cf_bm)$/i.test(n)).length,
    };
    return textResult(`Verdict: **${result.verdict}**${result.challenge_supported ? ' (page handler acts on it)' : ''}${result.retry ? ' (retry)' : ''}. ${result.next_step}`, data);
  },
});
