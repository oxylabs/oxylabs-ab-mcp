// Public programmatic API of the package: build the server, resolve settings, and the core HB helpers
// (session, hub, dashboard client, parameter validation, page classification).

export { buildServer, SERVER_NAME, SERVER_VERSION, type HbServer } from './mcp/server.js';
export { resolveSettings, describeSettings, type Settings, type CliFlags } from './settings.js';
export { HbSession } from './hb/session.js';
export { SessionHub } from './mcp/hub.js';
export { DashboardClient } from './hb/dashboard.js';
export { validateParams, mergeParams, toQueryString, HbParamsSchema, type HbParams } from './hb/params.js';
export { classify, type PageFacts, type Classification } from './hb/classify.js';
