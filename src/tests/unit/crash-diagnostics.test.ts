import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { LocalDevDiagnostics } from '../../local-dev.js';

test('a real child crash remains diagnosable through stdio MCP with no Tilt API', { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tilt-mcp-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, script] of Object.entries({
    k3d: 'console.log(JSON.stringify([{name:"wasm-platform",serversCount:1,serversRunning:1}]));',
    make: 'console.error("unexpected make invocation"); process.exitCode = 99;',
    tilt: 'console.log("Tilt starting"); console.error("panic: managed Tilt crashed"); process.exitCode = 23;',
  })) {
    await writeFile(join(dir, name), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
  }
  const client = new Client({ name: 'crash-diagnostics-test', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../../index.js', import.meta.url))],
    env: { PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`, HOME: homedir(), TILT_DEV_CONFIG: join(dir, 'missing-config') },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  t.after(() => client.close());
  await client.connect(transport);
  await client.callTool({ name: 'local_dev', arguments: { environment: 'wasm-platform', execute: 'start' } });
  const api = await client.callTool({ name: 'get-session', arguments: {} });
  assert.equal(api.isError, true);
  let diagnostics: LocalDevDiagnostics | undefined;
  const deadline = Date.now() + 3_000;
  do {
    const result = await client.callTool({ name: 'local_dev_diagnostics', arguments: { environment: 'wasm-platform' } });
    assert.notEqual(result.isError, true);
    diagnostics = result.structuredContent as LocalDevDiagnostics;
    if (diagnostics.status === 'exited' && diagnostics.output.text.includes('panic: managed Tilt crashed')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(diagnostics.status, 'exited');
  assert.ok('exitCode' in diagnostics);
  assert.equal(diagnostics.exitCode, 23);
  assert.equal(diagnostics.signal, null);
  assert.ok(diagnostics.pid);
  assert.ok(diagnostics.startedAt);
  assert.ok(diagnostics.exitedAt);
  assert.match(diagnostics.output.text, /Tilt starting/);
  assert.match(diagnostics.output.text, /panic: managed Tilt crashed/);
  assert.match(stderr, /panic: managed Tilt crashed/);
  const repeat = await client.callTool({ name: 'local_dev_diagnostics', arguments: { environment: 'wasm-platform' } });
  assert.deepEqual(repeat.structuredContent, diagnostics);
});
