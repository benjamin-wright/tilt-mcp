import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../server.js';
import type { LocalDev, LocalDevResult } from '../../local-dev.js';

const running: LocalDevResult = { environment: 'wasm-platform', status: 'running', tiltUrl: 'http://127.0.0.1:10350' };

async function connect(t: TestContext, localDev: Pick<LocalDev, 'execute'>): Promise<Client> {
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
  const client = await connect(t, { execute: async (...args) => { calls.push(args); return running; } });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 7);
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
  assert.deepEqual(calls, [['wasm-platform', 'start']]);
  assert.deepEqual(result.structuredContent, running);
});

test('invalid local_dev input is rejected before lifecycle code runs', async t => {
  let called = false;
  const client = await connect(t, { execute: async () => { called = true; return running; } });
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
  const client = await connect(t, { execute: async () => { throw new Error('Docker is not running'); } });
  const result = await client.callTool({ name: 'local_dev', arguments: { environment: 'db-operator', execute: 'start' } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Docker is not running/);
});
