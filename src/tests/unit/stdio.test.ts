import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('the built stdio server exposes local_dev, process diagnostics, Tilt and Kubernetes tools', async t => {
  const client = new Client({ name: 'stdio-smoke-test', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../../index.js', import.meta.url))],
    stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 12);
  assert.ok(tools.some(tool => tool.name === 'local_dev'));
  assert.ok(tools.some(tool => tool.name === 'local_dev_diagnostics'));
  assert.ok(tools.some(tool => tool.name === 'trigger-resource'));
  assert.ok(tools.some(tool => tool.name === 'cancel-resource'));
  assert.ok(tools.some(tool => tool.name === 'list_kubernetes_api_resources'));
  assert.ok(tools.some(tool => tool.name === 'list_kubernetes_resources'));
  assert.ok(tools.some(tool => tool.name === 'get_kubernetes_resource'));
  const result = await client.callTool({ name: 'local_dev_diagnostics', arguments: { environment: 'wasm-platform' } });
  assert.deepEqual(result.structuredContent, {
    environment: 'wasm-platform',
    status: 'not_started',
    output: { text: '', retainedBytes: 0, droppedBytes: 0 },
  });
});
