// Shared tool plumbing: the HbTool definition shape, the ToolContext handed to handlers, result helpers
// (markdown summary + JSON block) and the description of the common `session` argument.

import type { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Settings } from '../../settings.js';
import type { DashboardClient } from '../../hb/dashboard.js';
import type { SessionHub } from '../hub.js';
import type { Redactor } from '../../redact.js';

export interface ToolContext {
  settings: Settings;
  hub: SessionHub;
  dashboard: DashboardClient;
  redactor: Redactor;
  referenceDir: string;
  log: (message: string) => void;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface HbTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  handler: (args: z.output<S>, ctx: ToolContext, signal?: AbortSignal) => Promise<CallToolResult>;
}

export function defineTool<S extends z.ZodType>(tool: HbTool<S>): HbTool {
  return tool as unknown as HbTool;
}

/** Markdown summary followed by a fenced JSON block, so both humans and parsers get the data. */
export function textResult(summary: string, data?: unknown, isError = false): CallToolResult {
  const text = data === undefined ? summary : `${summary}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** Shared `session` argument for tools that act on one HB session. */
export const SESSION_ARG_DESCRIPTION = 'Label of the HB session to act on, as returned by hb_connect (also listed by hb_session_info).';

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `### Error\n${message}` }], isError: true };
}
