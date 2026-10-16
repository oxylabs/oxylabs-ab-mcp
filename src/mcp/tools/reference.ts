// hb_reference: returns the bundled parameter, error and challenge-handling reference documents from reference/*.md.

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defineTool, textResult } from './index.js';

export const REFERENCE_TOPICS = ['params', 'errors', 'challenges'] as const;
export type ReferenceTopic = (typeof REFERENCE_TOPICS)[number];

export async function readReference(referenceDir: string, topic: ReferenceTopic): Promise<string> {
  return fs.readFile(path.join(referenceDir, `${topic}.md`), 'utf8');
}

export const hbReference = defineTool({
  name: 'hb_reference',
  description:
    'Return the Oxylabs Agent Browser reference: connection parameters and their rules (params), the error catalogue with fixes (errors), or challenge handling usage (challenges). Read this before choosing hb_connect parameters or when a connect/navigation error is unclear.',
  input: z.object({ topic: z.enum([...REFERENCE_TOPICS, 'all']).describe('Which reference to return.') }),
  annotations: { title: 'HB reference', readOnlyHint: true },
  handler: async (args, ctx) => {
    const topics = args.topic === 'all' ? [...REFERENCE_TOPICS] : [args.topic];
    const parts = await Promise.all(topics.map((t) => readReference(ctx.referenceDir, t)));
    return textResult(parts.join('\n\n---\n\n'));
  },
});
