import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('the built stdio server exposes local_dev and the Tilt tools', async t => {
  const client = new Client({ name: 'stdio-smoke-test', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../../index.js', import.meta.url))],
    stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 7);
  assert.ok(tools.some(tool => tool.name === 'local_dev'));
  assert.ok(tools.some(tool => tool.name === 'trigger-resource'));
});
