// Streamable HTTP transport (single client) for the composite server, bound to localhost by default.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

/** Streamable HTTP transport on `/mcp` for one client at a time (Inspector, local agents). */
export async function startHttp(server: Server, host: string, port: number, log: (m: string) => void): Promise<http.Server> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('oxylabs-ab-mcp: use /mcp');
      return;
    }
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      log(`http error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  });
  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  log(`listening on http://${host}:${actualPort}/mcp`);
  return httpServer;
}
