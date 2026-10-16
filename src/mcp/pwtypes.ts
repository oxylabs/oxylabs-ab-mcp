// Type aliases derived from @playwright/mcp's public createConnection signature (the package does not export
// its config types as a subpath).

import type { createConnection } from '@playwright/mcp';

/** `@playwright/mcp` does not export its config subpath; derive the types from the public function. */
export type PlaywrightConfig = NonNullable<Parameters<typeof createConnection>[0]>;
export type ToolCapability = NonNullable<PlaywrightConfig['capabilities']>[number];
export type ContextGetter = NonNullable<Parameters<typeof createConnection>[1]>;
