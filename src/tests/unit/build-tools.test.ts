import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../server.js';
import type { BuildCancellationResult } from '../../tilt/client.js';

test('build trigger and cancellation tools restrict operations to named Tilt resources', async t => {
  const calls: Array<{ method: string; name: string; signal?: AbortSignal }> = [];
  let failure: Error | undefined;
  let cancellationStatus: BuildCancellationResult['status'] = 'cancel_requested';
  const builds = {
    async trigger(name: string, signal?: AbortSignal): Promise<void> {
      calls.push({ method: 'trigger', name, signal });
      if (failure) throw failure;
    },
    async cancel(name: string, signal?: AbortSignal): Promise<BuildCancellationResult> {
      calls.push({ method: 'cancel', name, signal });
      if (failure) throw failure;
      return { name, status: cancellationStatus };
    },
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ builds });
  const client = new Client({ name: 'build-tool-test', version: '0.1.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });

  await t.test('both tools advertise a strict bounded name and closed-world annotations', async () => {
    const { tools } = await client.listTools();
    for (const name of ['trigger-resource', 'cancel-resource']) {
      const tool = tools.find(tool => tool.name === name);
      assert.ok(tool);
      const schema = tool.inputSchema as unknown as {
        properties: { name: { type: string; minLength: number; maxLength: number } };
        required: string[];
        additionalProperties: boolean;
      };
      assert.deepEqual(Object.keys(schema.properties), ['name']);
      assert.deepEqual(schema.required, ['name']);
      assert.equal(schema.additionalProperties, false);
      assert.equal(schema.properties.name.type, 'string');
      assert.equal(schema.properties.name.minLength, 1);
      assert.equal(schema.properties.name.maxLength, 253);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: false, destructiveHint: name === 'cancel-resource', idempotentHint: false, openWorldHint: false,
      });
    }
  });

  await t.test('trigger forwards names with spaces and colons and the request signal', async () => {
    const result = await client.callTool({ name: 'trigger-resource', arguments: { name: 'wp: integration-tests' } });
    const call = calls.at(-1)!;
    assert.equal(call.method, 'trigger');
    assert.equal(call.name, 'wp: integration-tests');
    assert.ok(call.signal instanceof AbortSignal);
    assert.equal(call.signal.aborted, false);
    assert.deepEqual(result.content, [{ type: 'text', text: "Triggered rebuild of 'wp: integration-tests'." }]);
  });

  await t.test('cancel reports an active cancellation request and an idle no-op', async () => {
    const result = await client.callTool({ name: 'cancel-resource', arguments: { name: 'wp: unit-tests' } });
    const call = calls.at(-1)!;
    assert.equal(call.method, 'cancel');
    assert.equal(call.name, 'wp: unit-tests');
    assert.ok(call.signal instanceof AbortSignal);
    assert.equal(call.signal.aborted, false);
    assert.deepEqual(result.structuredContent, { name: 'wp: unit-tests', status: 'cancel_requested' });
    assert.deepEqual(result.content, [{ type: 'text', text: "Requested cancellation of the active build for 'wp: unit-tests'." }]);

    cancellationStatus = 'not_building';
    const idle = await client.callTool({ name: 'cancel-resource', arguments: { name: 'wp: unit-tests' } });
    assert.deepEqual(idle.structuredContent, { name: 'wp: unit-tests', status: 'not_building' });
    assert.deepEqual(idle.content, [{ type: 'text', text: "No active build for 'wp: unit-tests'." }]);
  });

  await t.test('invalid names and arbitrary operation parameters never reach either handler', async () => {
    const previousCalls = calls.length;
    const invalid: Record<string, unknown>[] = [
      {}, { name: '' }, { name: '   ' }, { name: 'task\nname' }, { name: 'task\u0000name' }, { name: 'task\u007fname' }, { name: 'a'.repeat(254) },
      { name: 'wp: unit-tests', command: 'kill -9 1' },
      { name: 'wp: unit-tests', args: ['delete', 'pods'] },
      { name: 'wp: unit-tests', flags: ['--server=http://example.com'] },
      { name: 'wp: unit-tests', path: '/etc/passwd' },
      { name: 'wp: unit-tests', pid: 1 },
      { name: 'wp: unit-tests', url: 'http://example.com' },
      { name: 'wp: unit-tests', action: 'delete' },
    ];
    for (const name of ['trigger-resource', 'cancel-resource']) {
      for (const arguments_ of invalid) {
        const result = await client.callTool({ name, arguments: arguments_ });
        assert.equal(result.isError, true, JSON.stringify({ name, arguments: arguments_ }));
      }
    }
    assert.equal(calls.length, previousCalls);
  });

  await t.test('build failures are returned as MCP tool errors', async () => {
    failure = new Error('Tilt build API unavailable');
    for (const name of ['trigger-resource', 'cancel-resource']) {
      const result = await client.callTool({ name, arguments: { name: 'wp: unit-tests' } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /Tilt build API unavailable/);
    }
    failure = undefined;
  });

  await t.test('client cancellation reaches both active build handlers', async () => {
    for (const name of ['trigger-resource', 'cancel-resource']) {
      let entered!: () => void;
      let interrupted!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const cancelled = new Promise<void>(resolve => { interrupted = resolve; });
      let handlerSignal: AbortSignal | undefined;
      const pendingHandler = async (signal?: AbortSignal) => {
        handlerSignal = signal;
        entered();
        await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => {
          interrupted();
          reject(signal!.reason);
        }, { once: true }));
      };
      if (name === 'trigger-resource') builds.trigger = async (_resource, signal) => pendingHandler(signal);
      else builds.cancel = async (resource, signal) => { await pendingHandler(signal); return { name: resource, status: 'cancel_requested' }; };
      const controller = new AbortController();
      const pending = client.callTool({ name, arguments: { name: 'wp: unit-tests' } }, undefined, { signal: controller.signal });
      const rejected = assert.rejects(pending, /client cancelled/);
      await ready;
      controller.abort(new Error('client cancelled'));
      await rejected;
      await cancelled;
      assert.equal(handlerSignal?.aborted, true);
    }
  });
});
