import https from 'node:https';
import type { KubeList, TiltView, UIResource, UISession, LogSegment } from './types.js';
import { loadTiltApiConfig, type TiltApiConfig } from './kubeconfig.js';

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = '10350';

function viewUrl(): string {
  const host = process.env['TILT_HOST'] ?? DEFAULT_HOST;
  const port = process.env['TILT_PORT'] ?? DEFAULT_PORT;
  return `http://${host}:${port}/api/view`;
}

function triggerUrl(): string {
  const host = process.env['TILT_HOST'] ?? DEFAULT_HOST;
  const port = process.env['TILT_PORT'] ?? DEFAULT_PORT;
  return `http://${host}:${port}/api/trigger`;
}

async function fetchView(timeoutMs = 10_000, signal?: AbortSignal): Promise<TiltView> {
  const url = viewUrl();
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
    response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
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

async function get<T>(config: TiltApiConfig, path: string, notFoundMessage?: string): Promise<T> {
  const url = `${config.server}/apis/tilt.dev/v1alpha1/${path}`;
  return new Promise<T>((resolve, reject) => {
    const req = https.request(url, { ca: config.ca, servername: config.certHost, headers: { Authorization: `Bearer ${config.token}` } }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode === 404 && notFoundMessage) {
          reject(new Error(notFoundMessage));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Tilt API error: ${res.statusCode} ${res.statusMessage} — ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(body) as T);
        } catch (err) {
          reject(new Error(`Failed to parse Tilt API response: ${String(err)}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', (err) => {
      reject(new Error(`Could not reach Tilt API at ${config.server}. Is Tilt running? (${String(err)})`));
    });
    req.end();
  });
}

export async function listResources(): Promise<UIResource[]> {
  const config = loadTiltApiConfig();
  const list = await get<KubeList<UIResource>>(config, 'uiresources');
  return list.items;
}

export async function getResource(name: string): Promise<UIResource> {
  const config = loadTiltApiConfig();
  return get<UIResource>(config, `uiresources/${encodeURIComponent(name)}`, `Resource not found: ${name}`);
}

export async function getSession(): Promise<UISession> {
  const config = loadTiltApiConfig();
  const list = await get<KubeList<UISession>>(config, 'uisessions');
  const session = list.items[0];
  if (!session) {
    throw new Error('No Tilt session found.');
  }
  return session;
}

export interface BuildWaitResult {
  elapsed: number;
  resources: Array<{ name: string; updateStatus: string; runtimeStatus: string; error?: string; skipped?: boolean }>;
}

const PENDING_UPDATE_STATUSES = new Set(['pending', 'in_progress']);
const POLL_INTERVAL_MS = 250;

interface PendingTrigger {
  baselineBuildStart?: string;
  sessionStart?: string;
}

// Kept in the MCP process so a trigger followed by a wait cannot return the
// previous successful build while Tilt is still scheduling the requested one.
const pendingTriggers = new Map<string, PendingTrigger>();

function sessionStart(view: TiltView): string | undefined {
  return view.uiSession?.status?.tiltStartTime ?? view.tiltStartTime;
}

function resourceError(resource: UIResource): string | undefined {
  if (resource.status.updateStatus === 'error') {
    return resource.status.buildHistory?.[0]?.error ?? 'Build or deployment failed.';
  }
  if (resource.status.runtimeStatus === 'error') return 'Runtime failed; inspect runtime logs.';
  return undefined;
}

function isSettled(resource: UIResource, view: TiltView): boolean {
  const pending = pendingTriggers.get(resource.metadata.name);
  if (pending) {
    if (pending.sessionStart !== sessionStart(view)) {
      throw new Error(`Tilt session changed after triggering '${resource.metadata.name}'. Trigger it again in the current session.`);
    }
    const latest = resource.status.buildHistory?.[0];
    if (!latest?.finishTime || latest.startTime === pending.baselineBuildStart) return false;
    pendingTriggers.delete(resource.metadata.name);
  }
  const status = resource.status;
  if (status.currentBuild || status.queued || PENDING_UPDATE_STATUSES.has(status.updateStatus ?? '')) return false;
  if (resourceError(resource)) return true;
  // Manual resources that have not been triggered are reported as skipped.
  if (status.updateStatus === 'none') return true;
  const updated = status.updateStatus === 'ok' || status.updateStatus === 'not_applicable';
  const ready = status.runtimeStatus === 'ok' || status.runtimeStatus === 'not_applicable';
  return updated && ready;
}

export async function waitForBuild(timeoutSeconds: number, names?: string[], signal?: AbortSignal): Promise<BuildWaitResult> {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 3_600) {
    throw new Error('timeoutSeconds must be greater than zero and at most 3600.');
  }
  if (names && (names.length === 0 || names.some(name => !name.trim()))) {
    throw new Error('names must contain at least one non-empty resource name.');
  }
  const start = Date.now();
  const deadline = start + timeoutSeconds * 1_000;
  const selected = names ? new Set(names) : undefined;
  let pendingNames: string[] = [];
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    // Each read contains every resource, unlike a watch's initial ADDED events.
    const view = await fetchView(Math.min(10_000, deadline - Date.now()), signal);
    const fatal = view.uiSession?.status?.fatalError;
    if (fatal) throw new Error(`Tilt session failed: ${fatal}`);
    const tiltfile = view.uiResources.find(r => r.metadata.name === '(Tiltfile)');
    if (tiltfile && resourceError(tiltfile)) throw new Error(`Tiltfile failed: ${resourceError(tiltfile)}`);
    const resources = view.uiResources.filter(r => r.metadata.name !== '(Tiltfile)' && (!selected || selected.has(r.metadata.name)));
    if (selected) {
      const missing = [...selected].filter(name => !resources.some(r => r.metadata.name === name));
      if (missing.length) throw new Error(`Resources not found: ${missing.join(', ')}`);
    }
    pendingNames = resources.filter(r => !isSettled(r, view)).map(r => r.metadata.name);
    if (tiltfile && !isSettled(tiltfile, view)) pendingNames.push('(Tiltfile)');
    if (resources.length > 0 && pendingNames.length === 0) {
      return {
        elapsed: Math.round((Date.now() - start) / 1_000),
        resources: resources.map(r => ({
          name: r.metadata.name,
          updateStatus: r.status.updateStatus ?? 'unknown',
          runtimeStatus: r.status.runtimeStatus ?? 'not_applicable',
          error: resourceError(r),
          skipped: r.status.updateStatus === 'none' || undefined,
        })),
      };
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(POLL_INTERVAL_MS, deadline - Date.now()))));
  }
  throw new Error(`Timed out after ${timeoutSeconds}s waiting for builds and runtime readiness. Still pending: ${pendingNames.join(', ') || 'no resources loaded'}`);
}

export async function triggerResource(name: string): Promise<void> {
  const view = await fetchView();
  const resource = view.uiResources.find(r => r.metadata.name === name);
  if (!resource) throw new Error(`Resource not found: ${name}`);
  const url = triggerUrl();
  const body = JSON.stringify({ manifest_names: [name], build_reason: 32 });
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
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
  // Tilt returns HTTP 200 with an error body when a resource is disabled.
  const responseBody = (await response.text()).trim();
  if (responseBody) throw new Error(`Tilt could not trigger '${name}': ${responseBody}`);
  pendingTriggers.set(name, {
    baselineBuildStart: resource.status.currentBuild?.startTime ?? resource.status.buildHistory?.[0]?.startTime,
    sessionStart: sessionStart(view),
  });
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
