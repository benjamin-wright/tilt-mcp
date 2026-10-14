import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ENVIRONMENTS, type Environment } from '../local-dev.js';
import { METADATA_LIST_ACCEPT } from './types.js';

export const KUBERNETES_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_KUBERNETES_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;

export interface KubernetesConfig {
  server: string;
  ca: Buffer;
  cert?: Buffer;
  key?: Buffer;
  token?: string;
}

export type KubernetesRequest = (
  environment: Environment,
  path: string,
  options?: { accept?: string; signal?: AbortSignal },
) => Promise<unknown>;

class ConfigurationError extends Error {}

function requireEnvironment(environment: Environment): void {
  if (!ENVIRONMENTS.includes(environment)) throw new ConfigurationError('Expected wasm-platform or db-operator');
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function namedEntry(entries: unknown, name: string): Record<string, unknown> | undefined {
  if (!Array.isArray(entries)) return undefined;
  const matching = entries.map(object).filter(entry => entry?.name === name);
  return matching.length === 1 ? matching[0] : undefined;
}

function embeddedData(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || value.length > MAX_CONFIG_BYTES) return undefined;
  const encoded = value.replace(/\s/g, '');
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
  const data = Buffer.from(encoded, 'base64');
  return data.length ? data : undefined;
}

function localServer(value: unknown): string {
  if (typeof value !== 'string' || /[?#@\s\\]/.test(value)) throw new ConfigurationError('Kubernetes server must be an HTTPS loopback address');
  let server: URL;
  try { server = new URL(value); }
  catch { throw new ConfigurationError('Kubernetes server must be an HTTPS loopback address'); }
  if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash || server.pathname !== '/' || !['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(server.hostname)) {
    throw new ConfigurationError('Kubernetes server must be an HTTPS loopback address without a base path');
  }
  if (server.hostname === '0.0.0.0') server.hostname = '127.0.0.1';
  return server.origin;
}

/** Reads only the environment's fixed local kubeconfig and its embedded credentials. */
export function loadKubernetesConfig(
  environment: Environment,
  dependencies: { readFile?: (path: string) => string; homeDir?: string } = {},
): KubernetesConfig {
  requireEnvironment(environment);
  const readFile = dependencies.readFile ?? (path => readFileSync(path, 'utf8'));
  let raw: string;
  try { raw = readFile(join(dependencies.homeDir ?? homedir(), '.scratch', `${environment}.yaml`)); }
  catch { throw new ConfigurationError(`Could not read Kubernetes configuration for ${environment}`); }
  if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) throw new ConfigurationError('Kubernetes configuration exceeds the size limit');
  let kube: Record<string, unknown> | undefined;
  try { kube = object(parse(raw)); }
  catch { throw new ConfigurationError(`Invalid Kubernetes configuration for ${environment}`); }
  if (!kube) throw new ConfigurationError(`Invalid Kubernetes configuration for ${environment}`);
  const context = object(namedEntry(kube.contexts, `k3d-${environment}`)?.context);
  if (!context || typeof context.cluster !== 'string' || typeof context.user !== 'string') throw new ConfigurationError('Kubernetes configuration must contain the managed environment context');
  const cluster = object(namedEntry(kube.clusters, context.cluster)?.cluster);
  const user = object(namedEntry(kube.users, context.user)?.user);
  if (!cluster || !user) throw new ConfigurationError('Kubernetes context must reference a named cluster and user');
  if (['certificate-authority', 'proxy-url', 'tls-server-name'].some(field => field in cluster) || (cluster['insecure-skip-tls-verify'] !== undefined && cluster['insecure-skip-tls-verify'] !== false)) {
    throw new ConfigurationError('Kubernetes configuration requires embedded CA data and verified direct TLS');
  }
  if (['exec', 'auth-provider', 'tokenFile', 'token-file', 'client-certificate', 'client-key'].some(field => field in user)) {
    throw new ConfigurationError('Kubernetes authentication must use embedded credentials without plugins or file references');
  }
  const server = localServer(cluster.server);
  const ca = embeddedData(cluster['certificate-authority-data']);
  const cert = embeddedData(user['client-certificate-data']);
  const key = embeddedData(user['client-key-data']);
  const hasCert = 'client-certificate-data' in user;
  const hasKey = 'client-key-data' in user;
  if (!ca || (hasCert || hasKey) && (!cert || !key)) throw new ConfigurationError('Kubernetes configuration requires embedded CA data and a complete client certificate/key pair');
  const token = user.token;
  if (token !== undefined && (typeof token !== 'string' || token.length > 8192 || !/^[\x21-\x7e]+$/.test(token))) {
    throw new ConfigurationError('Kubernetes configuration contains an invalid embedded token');
  }
  if (!cert && typeof token !== 'string') throw new ConfigurationError('Kubernetes configuration requires an embedded token or client certificate/key pair');
  return { server, ca, ...(cert && key ? { cert, key } : {}), ...(typeof token === 'string' ? { token } : {}) };
}

function validateApiPath(path: string): void {
  if (typeof path !== 'string' || !/^\/apis?(?:\/|\?|$)/.test(path) || /[\\#\x00-\x20\x7f]/.test(path)) throw new Error('Expected a Kubernetes API-relative path');
  let decoded: string;
  try { decoded = decodeURIComponent(path.split('?')[0]); }
  catch { throw new Error('Expected a Kubernetes API-relative path'); }
  if (decoded.includes('\\') || decoded.includes('//') || /[\x00-\x20\x7f%]/.test(decoded) || decoded.split('/').some(segment => segment === '.' || segment === '..') || /%2f|%5c/i.test(path.split('?')[0])) {
    throw new Error('Expected a Kubernetes API-relative path without traversal');
  }
}

/** Dependency injection is for connection tests; MCP callers cannot change destinations or limits. */
export function createKubernetesRequest(dependencies: {
  loadConfig?: (environment: Environment) => KubernetesConfig;
  request?: typeof https.request;
  timeoutMs?: number;
  maxResponseBytes?: number;
} = {}): KubernetesRequest {
  const timeoutMs = dependencies.timeoutMs ?? KUBERNETES_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = dependencies.maxResponseBytes ?? MAX_KUBERNETES_RESPONSE_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > KUBERNETES_REQUEST_TIMEOUT_MS || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_KUBERNETES_RESPONSE_BYTES) {
    throw new Error('Kubernetes connection limits must be positive and within their fixed maximums');
  }
  return async (environment, path, options = {}) => {
    requireEnvironment(environment);
    validateApiPath(path);
    const accept = options.accept ?? 'application/json';
    if (!['application/json', METADATA_LIST_ACCEPT].includes(accept)) throw new Error('Expected a supported Kubernetes JSON response format');
    if (options.signal?.aborted) throw new Error('Kubernetes request cancelled');
    let config: KubernetesConfig;
    try { config = (dependencies.loadConfig ?? loadKubernetesConfig)(environment); }
    catch (error) { throw error instanceof ConfigurationError ? error : new Error(`Could not load Kubernetes configuration for ${environment}`); }
    const url = new URL(`${localServer(config.server)}${path}`);
    return new Promise<unknown>((resolve, reject) => {
      let request: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        response?.destroy();
        request?.destroy();
        reject(new Error(message));
      };
      const onAbort = () => fail('Kubernetes request cancelled');
      options.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => fail(`Kubernetes request timed out after ${timeoutMs}ms`), timeoutMs);
      if (options.signal?.aborted) { onAbort(); return; }
      const receive = (incoming: IncomingMessage) => {
        response = incoming;
        response.on('error', () => fail('Could not read Kubernetes response'));
        response.once('aborted', () => fail('Kubernetes response was interrupted'));
        response.once('close', () => { if (!response?.complete) fail('Kubernetes response closed before completion'); });
        const status = response.statusCode;
        if (status === undefined || status < 200 || status >= 300) {
          fail(`Kubernetes API returned HTTP ${status ?? 'unknown'}`);
          return;
        }
        const contentLength = Number(response.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
          fail('Kubernetes response exceeds the size limit');
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > maxResponseBytes) { fail('Kubernetes response exceeds the size limit'); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.once('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString('utf8');
          let result: unknown;
          try { result = JSON.parse(text); }
          catch { fail('Kubernetes API returned an invalid JSON response'); return; }
          settled = true;
          cleanup();
          resolve(result);
        });
      };
      try {
        request = (dependencies.request ?? https.request)(url, {
          method: 'GET', ca: config.ca, cert: config.cert, key: config.key, rejectUnauthorized: true,
          headers: { Accept: accept, 'Accept-Encoding': 'identity', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) },
        }, receive);
        request.on('error', () => fail('Could not reach Kubernetes API over verified TLS'));
        if (settled) request.destroy();
        else request.end();
      } catch { fail('Could not start Kubernetes request'); }
    });
  };
}

export const requestKubernetes: KubernetesRequest = createKubernetesRequest();
