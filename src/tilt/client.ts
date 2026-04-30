import https from 'node:https';
import type { KubeList, WatchEvent, TiltView, UIResource, UISession, LogSegment } from './types.js';
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
  resources: Array<{ name: string; updateStatus: string; runtimeStatus: string; error?: string }>;
}

// Tilt's UpdateStatus values that indicate a build is still active. Anything
// else ('ok', 'error', 'not_applicable', 'none') means the build has settled.
const PENDING_UPDATE_STATUSES = new Set(['pending', 'in_progress']);

function isSettledStatus(updateStatus: string | undefined): boolean {
  return !PENDING_UPDATE_STATUSES.has(updateStatus ?? '');
}

export async function waitForBuild(timeoutSeconds: number): Promise<BuildWaitResult> {
  const config = loadTiltApiConfig();
  const start = Date.now();
  const url = `${config.server}/apis/tilt.dev/v1alpha1/uiresources?watch=true&resourceVersion=0`;
  const resources = new Map<string, UIResource>();

  return new Promise<BuildWaitResult>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const req = https.request(url, { ca: config.ca, servername: config.certHost, headers: { Authorization: `Bearer ${config.token}` } }, (res) => {
      let buf = '';

      const settle = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        req.destroy();
        const active = [...resources.values()].filter(r => r.metadata.name !== '(Tiltfile)');
        resolve({
          elapsed: Math.round((Date.now() - start) / 1_000),
          resources: active.map(r => ({
            name: r.metadata.name,
            updateStatus: r.status.updateStatus ?? 'unknown',
            runtimeStatus: r.status.runtimeStatus ?? 'not_applicable',
            error: r.status.buildHistory?.[0]?.error,
          })),
        });
      };

      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: WatchEvent<UIResource>;
          try {
            event = JSON.parse(line) as WatchEvent<UIResource>;
          } catch {
            continue;
          }
          if (event.type === 'ERROR') {
            if (!done) {
              done = true;
              clearTimeout(timer);
              reject(new Error(`Watch error from Tilt API: ${JSON.stringify(event.object)}`));
            }
            return;
          }
          if (event.type === 'DELETED') {
            resources.delete(event.object.metadata.name);
          } else {
            resources.set(event.object.metadata.name, event.object);
          }
          const active = [...resources.values()].filter(r => r.metadata.name !== '(Tiltfile)');
          if (active.length > 0 && active.every(r => isSettledStatus(r.status.updateStatus))) {
            settle();
            return;
          }
        }
      });

      res.on('end', settle);
      res.on('error', (err) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(err);
        }
      });
    });

    timer = setTimeout(() => {
      if (done) return;
      done = true;
      req.destroy();
      const names = [...resources.values()]
        .filter(r => r.metadata.name !== '(Tiltfile)' && !isSettledStatus(r.status.updateStatus))
        .map(r => r.metadata.name).join(', ');
      reject(new Error(
        `Timed out after ${timeoutSeconds}s waiting for builds to complete. Still pending: ${names || 'unknown'}`
      ));
    }, timeoutSeconds * 1_000);

    req.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`Could not reach Tilt API at ${config.server}. Is Tilt running? (${String(err)})`));
    });

    req.end();
  });
}

export async function triggerResource(name: string): Promise<void> {
  const url = triggerUrl();
  const body = JSON.stringify({ manifest_names: [name], build_reason: 16 });
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
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

