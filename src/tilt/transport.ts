import https from 'node:https';
import { createManagedCommandRunner } from '../process.js';
import { loadTiltApiConfig } from './kubeconfig.js';
import type { KubeList, LogSegment, TiltView, UIButton, UIResource, UISession } from './types.js';

export const tiltCommands = { run: createManagedCommandRunner({ timeoutMs: 10_000 }) };

export async function tiltRequest<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
  const config = loadTiltApiConfig();
  const timeout = AbortSignal.timeout(10_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const req = https.request(`${config.server}/apis/tilt.dev/v1alpha1/${path}`, {
      ca: config.ca, servername: config.certHost, signal: requestSignal,
      method: payload === undefined ? 'GET' : 'PUT',
      headers: { Authorization: `Bearer ${config.token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          res.destroy(new Error('Tilt API response exceeds the size limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`Tilt API error: HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
        catch { reject(new Error('Tilt API returned invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

export const tiltTransport = {
  async snapshot(signal?: AbortSignal): Promise<TiltView> {
    const [resources, sessions, buttons] = await Promise.all([
      tiltRequest<KubeList<UIResource>>('uiresources', signal),
      tiltRequest<KubeList<UISession>>('uisessions', signal),
      tiltRequest<KubeList<UIButton>>('uibuttons', signal),
    ]);
    if (!sessions.items[0]) throw new Error('No Tilt session found.');
    return { uiResources: resources.items, uiSession: sessions.items[0], uiButtons: buttons.items };
  },
  async trigger(name: string, signal?: AbortSignal): Promise<void> {
    await tiltCommands.run('tilt', ['trigger', '--', name], undefined, signal);
  },
  async cancel(button: UIButton, timestamp: string, signal?: AbortSignal): Promise<void> {
    await tiltRequest(`uibuttons/${encodeURIComponent(button.metadata.name)}/status`, signal, {
      metadata: button.metadata, status: { ...button.status, lastClickedAt: timestamp },
    });
  },
  async logs(name: string, source: 'all' | 'build' | 'runtime'): Promise<LogSegment[]> {
    const output = await tiltCommands.run('tilt', ['logs', '--json', '--source', 'all', '--tail', '2000', '--', name]);
    return output.split('\n').filter(line => line.trim()).flatMap(line => {
      const entry = JSON.parse(line) as { resource: string; source: string; spanID?: string; time?: string; message: string; level?: string };
      // Tilt calls local update-command output runtime, but it belongs with
      // build output here, as it did in the webview transport.
      const runtime = entry.spanID
        ? ['pod:', 'monitor:', 'events:'].some(prefix => entry.spanID!.startsWith(prefix))
        : entry.source === 'runtime';
      if (entry.resource !== name || source === 'runtime' && !runtime || source === 'build' && runtime) return [];
      return [{ spanId: entry.spanID, time: entry.time, text: entry.message + '\n', level: entry.level }];
    });
  },
};
