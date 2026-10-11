import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ENVIRONMENTS, type LocalDev } from '../local-dev.js';

export function registerLocalDevTool(server: McpServer, localDev: Pick<LocalDev, 'execute'>): void {
  server.registerTool('local_dev', {
    description: 'Start or stop wasm-platform or db-operator using its Makefile. Start tears down the other environment and runs Tilt until this MCP exits. Use the Tilt tools to inspect builds and tests.',
    inputSchema: z.object({
      environment: z.enum(ENVIRONMENTS),
      execute: z.enum(['start', 'stop']),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async ({ environment, execute }) => {
    try {
      const result = await localDev.execute(environment, execute);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });
}
