import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ENVIRONMENTS, type LocalDev } from '../local-dev.js';
import { DEFAULT_DIAGNOSTIC_BYTES, MAX_DIAGNOSTIC_BYTES } from '../tilt/process.js';

export function registerLocalDevTool(server: McpServer, localDev: Pick<LocalDev, 'execute' | 'diagnostics'>): void {
  server.registerTool('local_dev', {
    description: 'Start or stop wasm-platform or db-operator using its Makefile. Start tears down the other environment and runs Tilt until this MCP exits. Use the Tilt tools to inspect builds and tests. If Tilt exits or its API becomes unavailable, use local_dev_diagnostics to inspect its process and console output.',
    inputSchema: z.object({
      environment: z.enum(ENVIRONMENTS),
      execute: z.enum(['start', 'stop']),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async ({ environment, execute }, extra) => {
    try {
      const result = await localDev.execute(environment, execute, extra.signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });

  server.registerTool('local_dev_diagnostics', {
    description: 'Read the last Tilt process status and bounded console output retained by this MCP for an environment, including after Tilt crashes or its API becomes unavailable. This reads in-memory diagnostics only; it does not start processes or access files or the network.',
    inputSchema: z.object({
      environment: z.enum(ENVIRONMENTS),
      maxBytes: z.number().int().min(1).max(MAX_DIAGNOSTIC_BYTES).optional().describe(`Maximum console output bytes to return (default: ${DEFAULT_DIAGNOSTIC_BYTES}; maximum: ${MAX_DIAGNOSTIC_BYTES})`),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ environment, maxBytes }) => {
    try {
      const result = localDev.diagnostics(environment, maxBytes ?? DEFAULT_DIAGNOSTIC_BYTES);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });
}
