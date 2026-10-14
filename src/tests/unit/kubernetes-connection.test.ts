import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import {
  createKubernetesRequest, loadKubernetesConfig,
  KUBERNETES_REQUEST_TIMEOUT_MS, MAX_KUBERNETES_RESPONSE_BYTES, type KubernetesConfig,
} from '../../kubernetes/connection.js';
import type { Environment } from '../../local-dev.js';
import { METADATA_LIST_ACCEPT } from '../../kubernetes/types.js';

const encoded = (text: string) => Buffer.from(text).toString('base64');

function kubeFixture() {
  return {
    'current-context': 'unrelated',
    contexts: [
      { name: 'unrelated', context: { cluster: 'unrelated-cluster', user: 'unrelated-user' } },
      { name: 'k3d-wasm-platform', context: { cluster: 'managed-cluster', user: 'managed-user' } },
      { name: 'k3d-db-operator', context: { cluster: 'managed-cluster', user: 'managed-user' } },
    ],
    clusters: [
      { name: 'unrelated-cluster', cluster: { server: 'https://remote.invalid', 'certificate-authority-data': encoded('unrelated-ca') } },
      { name: 'managed-cluster', cluster: { server: 'https://0.0.0.0:6443', 'certificate-authority-data': encoded('managed-ca') } },
    ],
    users: [
      { name: 'unrelated-user', user: { exec: { command: 'never-execute-this' } } },
      { name: 'managed-user', user: { 'client-certificate-data': encoded('managed-cert'), 'client-key-data': encoded('SENSITIVE-KEY') } },
    ],
  };
}

function loadFixture(kube: unknown, environment: Environment = 'wasm-platform') {
  const reads: string[] = [];
  const config = loadKubernetesConfig(environment, {
    homeDir: '/test-home',
    readFile: path => { reads.push(path); return JSON.stringify(kube); },
  });
  return { config, reads };
}

class FakeRequest extends EventEmitter {
  ends = 0;
  destroys = 0;
  end(): this { this.ends++; return this; }
  destroy(): this { this.destroys++; return this; }
}

class FakeResponse extends EventEmitter {
  complete = false;
  destroys = 0;
  constructor(readonly statusCode = 200, readonly headers: Record<string, string> = {}) { super(); }
  destroy(): this { this.destroys++; return this; }
  send(chunk: Buffer | string): void { this.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
  finish(): void { this.complete = true; this.emit('end'); this.emit('close'); }
}

function connectionFixture(options: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
  const request = new FakeRequest();
  const calls: { url: URL; options: https.RequestOptions }[] = [];
  const environments: Environment[] = [];
  let receive!: (response: IncomingMessage) => void;
  const config: KubernetesConfig = {
    server: 'https://127.0.0.1:6443', ca: Buffer.from('ca'),
    cert: Buffer.from('cert'), key: Buffer.from('SENSITIVE-KEY'), token: 'SENSITIVE-TOKEN',
  };
  const transport = ((url: URL, requestOptions: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
    calls.push({ url, options: requestOptions });
    receive = callback;
    return request as unknown as ClientRequest;
  }) as unknown as typeof https.request;
  const query = createKubernetesRequest({
    loadConfig: environment => { environments.push(environment); return config; },
    request: transport,
    ...options,
  });
  return {
    query, request, calls, environments, config,
    respond: (status = 200, headers: Record<string, string> = {}) => {
      const response = new FakeResponse(status, headers);
      receive(response as unknown as IncomingMessage);
      return response;
    },
  };
}

test('kubeconfig uses the fixed environment file and named context references', () => {
  const { config, reads } = loadFixture(kubeFixture());
  assert.deepEqual(reads, ['/test-home/.scratch/wasm-platform.yaml']);
  assert.equal(config.server, 'https://127.0.0.1:6443');
  assert.equal(config.ca.toString(), 'managed-ca');
  assert.equal(config.cert?.toString(), 'managed-cert');
  assert.equal(config.key?.toString(), 'SENSITIVE-KEY');
  assert.equal(config.token, undefined);
  const other = loadFixture(kubeFixture(), 'db-operator');
  assert.deepEqual(other.reads, ['/test-home/.scratch/db-operator.yaml']);
});

test('embedded token authentication and all supported loopback hosts are accepted', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', '0.0.0.0']) {
    const kube = kubeFixture();
    kube.clusters[1].cluster.server = `https://${host}:6443/`;
    kube.users[1].user = { token: 'SENSITIVE-TOKEN' } as unknown as typeof kube.users[1]['user'];
    const { config } = loadFixture(kube);
    assert.equal(config.server, `https://${host === '0.0.0.0' ? '127.0.0.1' : host}:6443`);
    assert.equal(config.token, 'SENSITIVE-TOKEN');
    assert.equal(config.cert, undefined);
    assert.equal(config.key, undefined);
  }
});

test('selected authentication plugins and credential file references are rejected without additional reads', () => {
  for (const field of ['exec', 'auth-provider', 'tokenFile', 'token-file', 'client-certificate', 'client-key']) {
    const kube = kubeFixture();
    Object.assign(kube.users[1].user, { [field]: '/SENSITIVE-CREDENTIAL-FILE' });
    const reads: string[] = [];
    assert.throws(() => loadKubernetesConfig('wasm-platform', {
      homeDir: '/test-home', readFile: path => { reads.push(path); return JSON.stringify(kube); },
    }), /embedded credentials without plugins or file references/);
    assert.deepEqual(reads, ['/test-home/.scratch/wasm-platform.yaml']);
  }
});

test('CA file paths, proxy routing, certificate-name overrides and disabled TLS verification are rejected', () => {
  for (const [field, value] of [
    ['certificate-authority', '/SENSITIVE-CA'], ['proxy-url', 'https://remote.invalid'],
    ['tls-server-name', 'remote.invalid'], ['insecure-skip-tls-verify', true],
  ] as const) {
    const kube = kubeFixture();
    Object.assign(kube.clusters[1].cluster, { [field]: value });
    assert.throws(() => loadFixture(kube), /verified direct TLS/);
  }
});

test('remote servers, credentials, non-HTTPS URLs and server path/query overrides are rejected', () => {
  for (const server of [
    'http://127.0.0.1:6443', 'https://remote.invalid:6443', 'https://127.0.0.2:6443',
    'https://SENSITIVE-TOKEN@localhost:6443', 'https://localhost:6443/base',
    'https://localhost:6443?token=SENSITIVE-TOKEN', 'https://localhost:6443#fragment',
    'https://localhost:6443?', 'https://localhost:6443#', 'https://localhost:6443\n',
  ]) {
    const kube = kubeFixture();
    kube.clusters[1].cluster.server = server;
    assert.throws(() => loadFixture(kube), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTPS loopback address/);
      assert.ok(!error.message.includes('SENSITIVE'));
      assert.ok(!error.message.includes(server));
      return true;
    });
  }
});

test('missing or ambiguous context references and incomplete embedded credentials are rejected', () => {
  const missing = kubeFixture();
  missing.contexts[1].context.cluster = 'missing';
  assert.throws(() => loadFixture(missing), /named cluster and user/);
  const duplicate = kubeFixture();
  duplicate.clusters.push(duplicate.clusters[1]);
  assert.throws(() => loadFixture(duplicate), /named cluster and user/);
  const incomplete = kubeFixture();
  incomplete.users[1].user = { 'client-certificate-data': encoded('cert') } as typeof incomplete.users[1]['user'];
  assert.throws(() => loadFixture(incomplete), /complete client certificate\/key pair/);
  const badCa = kubeFixture();
  badCa.clusters[1].cluster['certificate-authority-data'] = 'not base64!';
  assert.throws(() => loadFixture(badCa), /embedded CA data/);
  const badToken = kubeFixture();
  badToken.users[1].user = { token: 'Bearer SENSITIVE-TOKEN\n' } as unknown as typeof badToken.users[1]['user'];
  assert.throws(() => loadFixture(badToken), /invalid embedded token/);
});

test('file and YAML errors cannot expose credentials, and unknown environments never read a file', () => {
  assert.throws(() => loadKubernetesConfig('wasm-platform', { readFile: () => { throw new Error('SENSITIVE-KEY'); } }), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Could not read Kubernetes configuration for wasm-platform');
    return true;
  });
  assert.throws(() => loadKubernetesConfig('wasm-platform', { readFile: () => 'token: [SENSITIVE-TOKEN' }), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Invalid Kubernetes configuration for wasm-platform');
    return true;
  });
  let read = false;
  assert.throws(() => loadKubernetesConfig('../production' as Environment, { readFile: () => { read = true; return ''; } }), /Expected wasm-platform or db-operator/);
  assert.equal(read, false);
});

test('requests are GET-only with verified TLS and embedded credentials, and parse JSON', async () => {
  const fake = connectionFixture();
  const waiting = fake.query('wasm-platform', '/api/v1/pods?limit=5&continue=abc%2B%2F%3D%5C');
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.environments, ['wasm-platform']);
  const call = fake.calls[0];
  assert.equal(call.url.origin, 'https://127.0.0.1:6443');
  assert.equal(call.url.pathname, '/api/v1/pods');
  assert.equal(call.url.searchParams.get('continue'), 'abc+/=\\');
  assert.equal(call.options.method, 'GET');
  assert.equal(call.options.rejectUnauthorized, true);
  assert.equal(call.options.ca, fake.config.ca);
  assert.equal(call.options.cert, fake.config.cert);
  assert.equal(call.options.key, fake.config.key);
  assert.deepEqual(call.options.headers, { Accept: 'application/json', 'Accept-Encoding': 'identity', Authorization: 'Bearer SENSITIVE-TOKEN' });
  const response = fake.respond();
  response.send('{"items":');
  response.send('[]}');
  response.finish();
  assert.deepEqual(await waiting, { items: [] });
  assert.equal(fake.request.ends, 1);
  assert.equal(fake.request.destroys, 0);
});

test('metadata list negotiation is accepted while arbitrary headers and unsafe paths are rejected before any access', async () => {
  const fake = connectionFixture();
  const waiting = fake.query('db-operator', '/apis/example.test/v1/widgets', { accept: METADATA_LIST_ACCEPT });
  assert.equal((fake.calls[0].options.headers as Record<string, string>).Accept, METADATA_LIST_ACCEPT);
  const response = fake.respond();
  response.send('{"items":[]}');
  response.finish();
  await waiting;
  for (const path of [
    'https://remote.invalid/api', '//localhost/api', '/healthz', '/apish',
    '/api/v1/../secrets', '/api/%2e%2e/secrets', '/apis/%252e%252e/secrets',
    '/api//pods', '/api/v1%2fpods', '/api\\v1/pods', '/api#fragment', '/api\n',
  ]) {
    await assert.rejects(fake.query('wasm-platform', path), /Kubernetes API-relative path/);
  }
  await assert.rejects(fake.query('wasm-platform', '/api', { accept: 'text/plain' }), /JSON response format/);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.environments.length, 1);
});

test('HTTP errors and redirects never expose response bodies or follow a second destination', async () => {
  for (const status of [302, 401, 403, 500]) {
    const fake = connectionFixture();
    const waiting = fake.query('wasm-platform', '/api');
    const response = fake.respond(status, { location: 'https://remote.invalid/secret' });
    response.send('SENSITIVE-TOKEN');
    await assert.rejects(waiting, error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `Kubernetes API returned HTTP ${status}`);
      return true;
    });
    assert.equal(fake.calls.length, 1);
    assert.ok(response.destroys > 0);
    assert.ok(fake.request.destroys > 0);
  }
});

test('response size is bounded for streamed bytes and advertised Content-Length', async () => {
  for (const advertised of [false, true]) {
    const fake = connectionFixture({ maxResponseBytes: 32 });
    const waiting = fake.query('wasm-platform', '/api');
    const response = fake.respond(200, advertised ? { 'content-length': '33' } : {});
    if (!advertised) { response.send(Buffer.alloc(20)); response.send(Buffer.alloc(13)); }
    await assert.rejects(waiting, /response exceeds the size limit/);
    assert.ok(response.destroys > 0);
    assert.ok(fake.request.destroys > 0);
  }
  const defaults = connectionFixture();
  const waiting = defaults.query('wasm-platform', '/api');
  defaults.respond().send(Buffer.alloc(MAX_KUBERNETES_RESPONSE_BYTES + 1));
  await assert.rejects(waiting, /response exceeds the size limit/);
});

test('the request deadline stays active after headers and body chunks arrive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = connectionFixture();
  const waiting = fake.query('wasm-platform', '/api');
  const rejected = assert.rejects(waiting, /timed out after 10000ms/);
  t.mock.timers.tick(5000);
  const response = fake.respond();
  response.send('{"items":');
  t.mock.timers.tick(KUBERNETES_REQUEST_TIMEOUT_MS - 5001);
  assert.equal(fake.request.destroys, 0);
  t.mock.timers.tick(1);
  await rejected;
  assert.ok(fake.request.destroys > 0);
  assert.ok(response.destroys > 0);
});

test('success clears the request deadline so a completed request is never destroyed later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = connectionFixture();
  const waiting = fake.query('wasm-platform', '/api');
  const response = fake.respond();
  response.send('{}');
  response.finish();
  await waiting;
  t.mock.timers.tick(KUBERNETES_REQUEST_TIMEOUT_MS * 2);
  assert.equal(fake.request.destroys, 0);
  assert.equal(response.destroys, 0);
});

test('cancellation destroys an in-flight request and ignores a sensitive cancellation reason', async () => {
  const fake = connectionFixture();
  const controller = new AbortController();
  const waiting = fake.query('wasm-platform', '/api', { signal: controller.signal });
  const response = fake.respond();
  response.send('{');
  controller.abort(new Error('SENSITIVE-TOKEN'));
  await assert.rejects(waiting, error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Kubernetes request cancelled');
    return true;
  });
  assert.ok(fake.request.destroys > 0);
  assert.ok(response.destroys > 0);
  const alreadyAborted = connectionFixture();
  await assert.rejects(alreadyAborted.query('db-operator', '/apis', { signal: controller.signal }), /cancelled/);
  assert.equal(alreadyAborted.environments.length, 0);
  assert.equal(alreadyAborted.calls.length, 0);
});

test('cancellation during config loading prevents the HTTPS request from starting', async () => {
  const controller = new AbortController();
  let requests = 0;
  const query = createKubernetesRequest({
    loadConfig: () => {
      controller.abort();
      return { server: 'https://127.0.0.1:6443', ca: Buffer.from('ca'), token: 'SENSITIVE-TOKEN' };
    },
    request: (() => { requests++; throw new Error('must not request'); }) as unknown as typeof https.request,
  });
  await assert.rejects(query('wasm-platform', '/api', { signal: controller.signal }), /cancelled/);
  assert.equal(requests, 0);
});

test('transport, response and parsing failures return safe errors without raw credentials', async () => {
  for (const event of ['request-error', 'response-error', 'aborted', 'close', 'invalid-json']) {
    const fake = connectionFixture();
    const waiting = fake.query('wasm-platform', '/api');
    if (event === 'request-error') {
      fake.request.emit('error', new Error('SENSITIVE-KEY'));
    } else {
      const response = fake.respond();
      if (event === 'response-error') response.emit('error', new Error('SENSITIVE-TOKEN'));
      else if (event === 'invalid-json') { response.send('SENSITIVE-TOKEN'); response.finish(); }
      else response.emit(event);
    }
    await assert.rejects(waiting, error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('SENSITIVE'));
      assert.match(error.message, /Kubernetes/);
      return true;
    });
  }
  const query = createKubernetesRequest({ loadConfig: () => { throw new Error('SENSITIVE-KEY'); } });
  await assert.rejects(query('wasm-platform', '/api'), /Could not load Kubernetes configuration for wasm-platform/);
});

test('test dependencies may reduce limits but cannot disable or enlarge fixed bounds', () => {
  for (const limits of [
    { timeoutMs: 0 }, { timeoutMs: KUBERNETES_REQUEST_TIMEOUT_MS + 1 }, { timeoutMs: 1.5 },
    { maxResponseBytes: 0 }, { maxResponseBytes: MAX_KUBERNETES_RESPONSE_BYTES + 1 }, { maxResponseBytes: Infinity },
  ]) {
    assert.throws(() => createKubernetesRequest(limits), /within their fixed maximums/);
  }
});
