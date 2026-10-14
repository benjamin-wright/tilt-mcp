import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResources, getResource, getSession, getResourceLogs, waitForBuild, triggerResource, cancelResource, type BuildCancellationResult } from './tilt/client.js';
import type { LogType } from './tilt/client.js';
import { registerLocalDevTool } from './tools/local-dev.js';
import { registerKubernetesTools } from './tools/kubernetes.js';
import { LocalDev } from './local-dev.js';
import { KubernetesClient } from './kubernetes/client.js';

function describeBuildStatus(updateStatus: string | undefined): string {
  switch (updateStatus) {
    case 'ok':      return 'ok';
    case 'error':   return 'error';
    case 'pending': return 'building';
    case 'none':    return 'not-triggered (manual)';
    default:        return updateStatus ?? 'unknown';
  }
}

export function createServer({ localDev = new LocalDev(), kubernetes = new KubernetesClient(), builds = { trigger: triggerResource, cancel: cancelResource } }: {
  localDev?: Pick<LocalDev, 'execute' | 'diagnostics'>;
  kubernetes?: Pick<KubernetesClient, 'listApiResources' | 'listResources' | 'getResource'>;
  builds?: { trigger(name: string, signal?: AbortSignal): Promise<void>; cancel(name: string, signal?: AbortSignal): Promise<BuildCancellationResult> };
} = {}): McpServer {
  const server = new McpServer({
    name: 'tilt-mcp',
    version: '0.1.0',
  }, { instructions: 'Use local_dev to start one local environment, then use resource, log, trigger and wait tools to iterate on builds, deployments and tests. Tilt runs for this MCP session; inspect build and test results after starting. Use trigger-resource to run a named build or test, cancel-resource to cancel its active build, and wait-for-build to inspect completion. Cancelling a wait does not cancel its build. local_dev stop can interrupt startup for the same environment and tears down its cluster. If Tilt exits or its API becomes unavailable, use local_dev_diagnostics with the environment to inspect the last process status and retained console output. Use list_kubernetes_api_resources to discover available Kubernetes kinds, list_kubernetes_resources to inspect their metadata, and get_kubernetes_resource for one resource in full detail.' });

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
      description: 'Wait for Tilt builds/deployments and runtime readiness, or terminal errors. Optionally select resources by name. Manual resources that have not run are reported as skipped. After trigger-resource, waits for a fresh completed build. Use this instead of polling resource tools.',
      inputSchema: z.object({
        timeoutSeconds: z.number().int().positive().max(3600).optional().describe('How long to wait before giving up (default: 120; maximum: 3600)'),
        names: z.array(z.string().min(1)).nonempty().optional().describe('Resources to wait for (default: all resources)'),
      }),
    },
    async ({ timeoutSeconds, names }, extra) => {
      const progressToken = extra._meta?.progressToken;
      let progress = 0;
      const heartbeat = progressToken === undefined ? undefined : setInterval(() => {
        void extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress: ++progress, message: 'Waiting for Tilt builds and runtime readiness.' },
        }).catch(() => {});
      }, 5_000);
      try {
        const result = await waitForBuild(timeoutSeconds ?? 120, names, extra.signal);
        const errors = result.resources.filter(r => r.error);
        const skipped = result.resources.filter(r => r.skipped);
        const lines = [
          `Resources settled in ${result.elapsed}s.`,
          errors.length ? `${errors.length} resource(s) with errors:` : skipped.length === result.resources.length ? 'No selected resources have run yet.' : 'Built resources are ready.',
          ...(skipped.length ? [`${skipped.length} manual resource(s) have not run; trigger them to execute their builds/tests.`] : []),
          '',
          ...result.resources.map(r => {
            const errSuffix = r.error ? `  ← ${r.error}` : '';
            return `${r.name}  build=${describeBuildStatus(r.updateStatus)}  runtime=${r.runtimeStatus}${errSuffix}`;
          }),
        ];
        return {
          isError: errors.length > 0,
          content: [{ type: 'text', text: lines.join('\n') }],
        };
      } finally {
        clearInterval(heartbeat);
      }
    }
  );

  const buildTaskInput = z.object({
    name: z.string().min(1).max(253).refine(name => Boolean(name.trim()) && !/[\x00-\x1f\x7f]/.test(name), 'Expected a Tilt resource name').describe('The name of the Tilt build or test resource'),
  }).strict();
  server.registerTool(
    'trigger-resource',
    {
      title: 'Trigger Tilt Resource Build',
      description: 'Manually trigger a rebuild of a named Tilt resource. Equivalent to clicking the rebuild button in the Tilt UI.',
      inputSchema: buildTaskInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name }, extra) => {
      await builds.trigger(name, extra.signal);
      return {
        content: [{ type: 'text', text: `Triggered rebuild of '${name}'.` }],
      };
    }
  );

  server.registerTool('cancel-resource', {
    title: 'Cancel Tilt Resource Build',
    description: 'Request cancellation of the active build or test for one named Tilt resource using its generated Stop Build button. Idle resources are a no-op; queued-only tasks cannot be cancelled. Does not stop runtime services, disable resources or tear down the environment. Use get-resource or wait-for-build to inspect the resulting build status.',
    inputSchema: buildTaskInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ name }, extra) => {
    const result = await builds.cancel(name, extra.signal);
    return {
      content: [{ type: 'text', text: result.status === 'cancel_requested' ? `Requested cancellation of the active build for '${name}'.` : `No active build for '${name}'.` }],
      structuredContent: { ...result },
    };
  });

  registerLocalDevTool(server, localDev);
  registerKubernetesTools(server, kubernetes);
  return server;
}
