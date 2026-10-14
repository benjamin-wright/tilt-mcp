import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../server.js';
import { LocalDev, type Environment, type LocalDevDiagnostics, type LocalDevResult } from '../../local-dev.js';
import { DEFAULT_DIAGNOSTIC_BYTES, MAX_DIAGNOSTIC_BYTES } from '../../tilt/process.js';

const running: LocalDevResult = { environment: 'wasm-platform', status: 'running', tiltUrl: 'http://127.0.0.1:10350' };
const noSessionDiagnostics = (environment: Environment): LocalDevDiagnostics => ({ environment, status: 'not_started', output: { text: '', retainedBytes: 0, droppedBytes: 0 } });

async function connect(t: TestContext, localDev: Pick<LocalDev, 'execute' | 'diagnostics'>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ localDev });
  const client = new Client({ name: 'local-dev-test', version: '0.1.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('local_dev is exposed alongside the existing Tilt tools with its exact contract', async t => {
  const calls: unknown[] = [];
  const client = await connect(t, { execute: async (...args) => { calls.push(args); return running; }, diagnostics: noSessionDiagnostics });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 12);
  assert.ok(tools.some(tool => tool.name === 'wait-for-build'));
  const tool = tools.find(tool => tool.name === 'local_dev');
  assert.ok(tool);
  const schema = tool.inputSchema as unknown as {
    properties: Record<string, { enum: string[] }>;
    required: string[];
    additionalProperties: boolean;
  };
  assert.deepEqual(schema.properties.environment.enum, ['wasm-platform', 'db-operator']);
  assert.deepEqual(schema.properties.execute.enum, ['start', 'stop']);
  assert.deepEqual(schema.required, ['environment', 'execute']);
  assert.equal(schema.additionalProperties, false);
  const result = await client.callTool({ name: 'local_dev', arguments: { environment: 'wasm-platform', execute: 'start' } });
  assert.deepEqual(calls.map(args => (args as unknown[]).slice(0, 2)), [['wasm-platform', 'start']]);
  assert.ok((calls[0] as unknown[])[2] instanceof AbortSignal);
  assert.deepEqual(result.structuredContent, running);
});

test('invalid local_dev input is rejected before lifecycle code runs', async t => {
  let called = false;
  const client = await connect(t, { execute: async () => { called = true; return running; }, diagnostics: noSessionDiagnostics });
  for (const args of [
    { environment: 'production', execute: 'start' },
    { environment: 'db-operator', execute: 'delete-all' },
    { environment: 'wasm-platform' },
    { environment: 'wasm-platform', execute: 'start', command: 'anything' },
  ]) {
    const result = await client.callTool({ name: 'local_dev', arguments: args });
    assert.equal(result.isError, true);
  }
  assert.equal(called, false);
});

test('lifecycle failures become MCP tool errors', async t => {
  const client = await connect(t, { execute: async () => { throw new Error('Docker is not running'); }, diagnostics: noSessionDiagnostics });
  const result = await client.callTool({ name: 'local_dev', arguments: { environment: 'db-operator', execute: 'start' } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Docker is not running/);
});

test('local_dev_diagnostics exposes only a bounded read-only process query', async t => {
  const client = await connect(t, { execute: async () => { throw new Error('Lifecycle commands must not run'); }, diagnostics: noSessionDiagnostics });
  const { tools } = await client.listTools();
  const tool = tools.find(tool => tool.name === 'local_dev_diagnostics');
  assert.ok(tool);
  assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  const schema = tool.inputSchema as unknown as {
    properties: Record<string, { enum?: string[]; type?: string; minimum?: number; maximum?: number }>;
    required: string[];
    additionalProperties: boolean;
  };
  assert.deepEqual(Object.keys(schema.properties), ['environment', 'maxBytes']);
  assert.deepEqual(schema.properties.environment.enum, ['wasm-platform', 'db-operator']);
  assert.equal(schema.properties.maxBytes.type, 'integer');
  assert.equal(schema.properties.maxBytes.minimum, 1);
  assert.equal(schema.properties.maxBytes.maximum, MAX_DIAGNOSTIC_BYTES);
  assert.deepEqual(schema.required, ['environment']);
  assert.equal(schema.additionalProperties, false);
});

test('diagnostics reports no process and a crashed process without lifecycle or Tilt API access', async t => {
  const api = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Tilt API is unavailable'); });
  const crashed: LocalDevDiagnostics = {
    environment: 'db-operator',
    status: 'exited',
    pid: 42,
    startedAt: '2026-10-13T12:00:00.000Z',
    exitedAt: '2026-10-13T12:01:00.000Z',
    exitCode: 1,
    signal: null,
    output: { text: 'Tilt failed: port already in use\n', retainedBytes: 32, droppedBytes: 80 },
  };
  const calls: unknown[] = [];
  const client = await connect(t, {
    execute: async () => { throw new Error('Lifecycle commands must not run'); },
    diagnostics: (environment, maxBytes) => {
      calls.push([environment, maxBytes]);
      return environment === 'db-operator' ? crashed : noSessionDiagnostics(environment);
    },
  });
  const noProcessResult = await client.callTool({ name: 'local_dev_diagnostics', arguments: { environment: 'wasm-platform' } });
  assert.deepEqual(noProcessResult.structuredContent, noSessionDiagnostics('wasm-platform'));
  const crashResult = await client.callTool({ name: 'local_dev_diagnostics', arguments: { environment: 'db-operator', maxBytes: 128 } });
  assert.deepEqual(crashResult.structuredContent, crashed);
  assert.deepEqual(crashResult.content, [{ type: 'text', text: JSON.stringify(crashed) }]);
  assert.deepEqual(calls, [['wasm-platform', DEFAULT_DIAGNOSTIC_BYTES], ['db-operator', 128]]);
  assert.equal(api.mock.calls.length, 0);
});

test('unsafe or invalid diagnostics input is rejected before diagnostics runs', async t => {
  let called = false;
  const client = await connect(t, {
    execute: async () => { throw new Error('Lifecycle commands must not run'); },
    diagnostics: environment => { called = true; return noSessionDiagnostics(environment); },
  });
  for (const args of [
    {},
    { environment: 'production' },
    { environment: 'wasm-platform', command: 'cat /etc/passwd' },
    { environment: 'wasm-platform', path: '/etc/passwd' },
    { environment: 'wasm-platform', pid: 1 },
    { environment: 'wasm-platform', url: 'http://example.com' },
    { environment: 'wasm-platform', maxBytes: 0 },
    { environment: 'wasm-platform', maxBytes: -1 },
    { environment: 'wasm-platform', maxBytes: 1.5 },
    { environment: 'wasm-platform', maxBytes: MAX_DIAGNOSTIC_BYTES + 1 },
    { environment: 'wasm-platform', maxBytes: '100' },
  ]) {
    const result = await client.callTool({ name: 'local_dev_diagnostics', arguments: args });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(called, false);
});

test('diagnostics failures become MCP tool errors', async t => {
  const client = await connect(t, {
    execute: async () => { throw new Error('Lifecycle commands must not run'); },
    diagnostics: () => { throw new Error('No retained process diagnostics'); },
  });
  const result = await client.callTool({ name: 'local_dev_diagnostics', arguments: { environment: 'db-operator' } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /No retained process diagnostics/);
});

test('MCP request cancellation aborts the local_dev command signal', async t => {
  let entered!: () => void;
  let cancelled!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const interrupted = new Promise<void>(resolve => { cancelled = resolve; });
  let commandSignal: AbortSignal | undefined;
  const dev = new LocalDev({
    run: async (_command, _args, _cwd, signal) => {
      commandSignal = signal;
      entered();
      return new Promise<string>((_resolve, reject) => signal!.addEventListener('abort', () => {
        cancelled();
        reject(signal!.reason);
      }, { once: true }));
    },
    startTilt: async () => { throw new Error('Cancelled setup must not launch Tilt'); },
  });
  const client = await connect(t, dev);
  const controller = new AbortController();
  const pending = client.callTool({ name: 'local_dev', arguments: { environment: 'wasm-platform', execute: 'start' } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /client cancelled/);
  await ready;
  controller.abort(new Error('client cancelled'));
  await rejected;
  await interrupted;
  assert.equal(commandSignal?.aborted, true);
  await dev.close();
});
