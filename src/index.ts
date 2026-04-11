#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listResources, getResource, getSession } from './tilt/client.js';

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
    const list = await listResources();
    const lines = list.items.map(r => {
      const build = r.status.currentBuild;
      const buildStatus = build?.error
        ? `build-error: ${build.error}`
        : build?.finishTime
          ? 'build-ok'
          : 'building';
      return `${r.metadata.name}  build=${buildStatus}  runtime=${r.status.runtimeStatus ?? 'unknown'}`;
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
      `tilt version: ${s.runningTiltBuild.version}${s.runningTiltBuild.dev ? ' (dev)' : ''}`,
      `started: ${s.startTime}`,
      `pid: ${s.pid}`,
      s.fatalError ? `fatal error: ${s.fatalError}` : 'no fatal errors',
    ];
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
