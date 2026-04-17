#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listResources, getResource, getSession, getResourceLogs, waitForBuild, triggerResource } from './tilt/client.js';
import type { LogType } from './tilt/client.js';

function describeBuildStatus(updateStatus: string | undefined): string {
  switch (updateStatus) {
    case 'ok':      return 'ok';
    case 'error':   return 'error';
    case 'pending': return 'building';
    case 'none':    return 'not-triggered (manual)';
    default:        return updateStatus ?? 'unknown';
  }
}

const server = new McpServer({
  name: 'tilt-mcp',
  version: '0.1.0',
});

server.registerTool(
  'list-resources',
  {
    title: 'List Tilt Resources',
    description: 'List all resources in the current Tilt session with their build and runtime status.',
    inputSchema: z.object({}),
  },
  async () => {
    const resources = await listResources();
    const lines = resources.map(r => {
      const buildStatus = describeBuildStatus(r.status.updateStatus);
      return `${r.metadata.name}  build=${buildStatus}  runtime=${r.status.runtimeStatus ?? 'not_applicable'}`;
    });
    return {
      content: [{ type: 'text', text: lines.length ? lines.join('\n') : 'No resources found.' }],
    };
  }
);

server.registerTool(
  'get-resource',
  {
    title: 'Get Tilt Resource',
    description: 'Get the full build and runtime status for a named Tilt resource.',
    inputSchema: z.object({
      name: z.string().describe('The name of the Tilt resource'),
    }),
  },
  async ({ name }) => {
    const resource = await getResource(name);
    return {
      content: [{ type: 'text', text: JSON.stringify(resource, null, 2) }],
    };
  }
);

server.registerTool(
  'get-session',
  {
    title: 'Get Tilt Session',
    description: 'Get the overall Tilt session state: version, start time, and any fatal errors.',
    inputSchema: z.object({}),
  },
  async () => {
    const session = await getSession();
    const s = session.status;
    const lines = [
      `tilt version: ${s.runningTiltBuild?.version ?? 'unknown'}${s.runningTiltBuild?.dev ? ' (dev)' : ''}`,
      `started: ${s.tiltStartTime ?? 'unknown'}`,
      `tiltfile: ${s.tiltfileKey ?? 'unknown'}`,
      s.fatalError ? `fatal error: ${s.fatalError}` : 'no fatal errors',
    ];
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  }
);

server.registerTool(
  'get-resource-logs',
  {
    title: 'Get Tilt Resource Logs',
    description: 'Get log output for a named Tilt resource. Use logType to filter: "build" for build/deploy logs, "runtime" for pod/container logs, "all" for everything (default).',
    inputSchema: z.object({
      name: z.string().describe('The name of the Tilt resource'),
      logType: z.enum(['all', 'build', 'runtime']).optional().describe('Which logs to return: "build" (build and deploy), "runtime" (pod/container/monitor), or "all" (default)'),
    }),
  },
  async ({ name, logType }) => {
    const segments = await getResourceLogs(name, (logType ?? 'all') as LogType);
    const text = segments.map(s => s.text).join('');
    return {
      content: [{ type: 'text', text: text || 'No logs found.' }],
    };
  }
);

server.registerTool(
  'wait-for-build',
  {
    title: 'Wait for Tilt Build',
    description: 'Block until all Tilt resources have finished building (no resource is in a pending state). Returns a summary of each resource with its final build and runtime status. Use this instead of polling get-resource or list-resources in a loop.',
    inputSchema: z.object({
      timeoutSeconds: z.number().int().positive().optional().describe('How long to wait before giving up (default: 120)'),
    }),
  },
  async ({ timeoutSeconds }) => {
    const result = await waitForBuild(timeoutSeconds ?? 120);
    const errors = result.resources.filter(r => r.error);
    const lines = [
      `Build complete in ${result.elapsed}s.`,
      errors.length ? `${errors.length} resource(s) with errors:` : 'All resources built successfully.',
      '',
      ...result.resources.map(r => {
        const errSuffix = r.error ? `  ← ${r.error}` : '';
        return `${r.name}  build=${describeBuildStatus(r.updateStatus)}  runtime=${r.runtimeStatus}${errSuffix}`;
      }),
    ];
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  }
);

server.registerTool(
  'trigger-resource',
  {
    title: 'Trigger Tilt Resource Build',
    description: 'Manually trigger a rebuild of a named Tilt resource. Equivalent to clicking the rebuild button in the Tilt UI.',
    inputSchema: z.object({
      name: z.string().describe('The name of the Tilt resource to rebuild'),
    }),
  },
  async ({ name }) => {
    await triggerResource(name);
    return {
      content: [{ type: 'text', text: `Triggered rebuild of '${name}'.` }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
