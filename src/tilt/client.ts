import type { TiltView, UIResource, UISession, LogSegment } from './types.js';

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = '10350';

function viewUrl(): string {
  const host = process.env['TILT_HOST'] ?? DEFAULT_HOST;
  const port = process.env['TILT_PORT'] ?? DEFAULT_PORT;
  return `http://${host}:${port}/api/view`;
}

async function fetchView(): Promise<TiltView> {
  const url = viewUrl();
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    const host = process.env['TILT_HOST'] ?? DEFAULT_HOST;
    const port = process.env['TILT_PORT'] ?? DEFAULT_PORT;
    throw new Error(
      `Could not reach Tilt at ${host}:${port}. Is Tilt running? (${String(err)})`
    );
  }
  if (!response.ok) {
    throw new Error(`Tilt API error: ${response.status} ${response.statusText} — ${url}`);
  }
  return response.json() as Promise<TiltView>;
}

export async function listResources(): Promise<UIResource[]> {
  const view = await fetchView();
  return view.uiResources;
}

export async function getResource(name: string): Promise<UIResource> {
  const view = await fetchView();
  const resource = view.uiResources.find(r => r.metadata.name === name);
  if (!resource) {
    throw new Error(`Resource not found: ${name}`);
  }
  return resource;
}

export async function getSession(): Promise<UISession> {
  const view = await fetchView();
  return view.uiSession;
}

export interface BuildWaitResult {
  elapsed: number;
  resources: Array<{ name: string; updateStatus: string; runtimeStatus: string; error?: string }>;
}

const POLL_INTERVAL_MS = 1_000;

export async function waitForBuild(timeoutSeconds: number): Promise<BuildWaitResult> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  const start = Date.now();

  while (true) {
    const view = await fetchView();
    const resources = view.uiResources.filter(r => r.metadata.name !== '(Tiltfile)');

    const pending = resources.filter(r => r.status.updateStatus === 'pending');
    if (pending.length === 0) {
      return {
        elapsed: Math.round((Date.now() - start) / 1_000),
        resources: resources.map(r => ({
          name: r.metadata.name,
          updateStatus: r.status.updateStatus ?? 'unknown',
          runtimeStatus: r.status.runtimeStatus ?? 'not_applicable',
          error: r.status.buildHistory?.[0]?.error,
        })),
      };
    }

    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      const names = pending.map(r => r.metadata.name).join(', ');
      throw new Error(
        `Timed out after ${timeoutSeconds}s waiting for builds to complete. Still pending: ${names}`
      );
    }

    await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export type LogType = 'all' | 'build' | 'runtime';

const RUNTIME_PREFIXES = ['pod:', 'monitor:', 'events:'];

export async function getResourceLogs(name: string, logType: LogType = 'all'): Promise<LogSegment[]> {
  const view = await fetchView();
  const resource = view.uiResources.find(r => r.metadata.name === name);
  if (!resource) {
    throw new Error(`Resource not found: ${name}`);
  }

  const spans = view.logList?.spans ?? {};
  const matchingSpanIds = new Set(
    Object.entries(spans)
      .filter(([id, info]) => {
        if (info.manifestName !== name) return false;
        const isRuntime = RUNTIME_PREFIXES.some(p => id.startsWith(p));
        if (logType === 'build') return !isRuntime;
        if (logType === 'runtime') return isRuntime;
        return true;
      })
      .map(([id]) => id)
  );

  if (matchingSpanIds.size === 0) {
    return [];
  }

  return (view.logList?.segments ?? []).filter(
    s => s.spanId !== undefined && matchingSpanIds.has(s.spanId)
  );
}
