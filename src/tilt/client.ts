import type { UIResourceList, UIResource, UISession } from './types.js';

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = '10350';
const API_BASE = '/apis/tilt.dev/v1alpha1';

function baseUrl(): string {
  const host = process.env['TILT_HOST'] ?? DEFAULT_HOST;
  const port = process.env['TILT_PORT'] ?? DEFAULT_PORT;
  return `http://${host}:${port}${API_BASE}`;
}

async function tiltGet<T>(path: string): Promise<T> {
  const url = `${baseUrl()}${path}`;
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
  return response.json() as Promise<T>;
}

export async function listResources(): Promise<UIResourceList> {
  return tiltGet<UIResourceList>('/uiresources');
}

export async function getResource(name: string): Promise<UIResource> {
  return tiltGet<UIResource>(`/uiresources/${encodeURIComponent(name)}`);
}

export async function getSession(): Promise<UISession> {
  return tiltGet<UISession>('/uisessions/Tiltfile');
}
