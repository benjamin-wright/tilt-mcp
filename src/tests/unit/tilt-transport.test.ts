import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tiltCommands, tiltTransport } from '../../tilt/transport.js';

test('trigger passes resource names as one positional CLI argument and forwards cancellation', async t => {
  const signal = new AbortController().signal;
  const calls: unknown[][] = [];
  t.mock.method(tiltCommands, 'run', async (...args: unknown[]) => { calls.push(args); return 'Triggered'; });
  await tiltTransport.trigger('wp: integration-tests', signal);
  await tiltTransport.trigger('--help', signal);
  assert.deepEqual(calls, [
    ['tilt', ['trigger', '--', 'wp: integration-tests'], undefined, signal],
    ['tilt', ['trigger', '--', '--help'], undefined, signal],
  ]);
});

test('logs filter structured startup records as well as requesting the bounded CLI source', async t => {
  const records = [
    { resource: 'task', source: 'build', message: 'Initial Build' },
    { resource: 'task', source: 'runtime', message: 'ready', spanID: 'pod:task', time: 'now', level: 'info' },
    { resource: 'task', source: 'runtime', message: 'test passed', spanID: 'cmd:task:update' },
    { resource: 'another-task', source: 'runtime', message: 'unrelated' },
  ];
  const calls: unknown[][] = [];
  t.mock.method(tiltCommands, 'run', async (...args: unknown[]) => {
    calls.push(args);
    return records.map(record => JSON.stringify(record)).join('\n') + '\n';
  });
  assert.deepEqual(await tiltTransport.logs('task', 'runtime'), [
    { spanId: 'pod:task', time: 'now', text: 'ready\n', level: 'info' },
  ]);
  assert.deepEqual(calls, [['tilt', ['logs', '--json', '--source', 'all', '--tail', '2000', '--', 'task']]]);
  assert.equal((await tiltTransport.logs('task', 'all')).length, 3);
  assert.deepEqual((await tiltTransport.logs('task', 'build')).map(segment => segment.text), ['Initial Build\n', 'test passed\n']);
});

test('CLI failures and invalid log output fail the tool instead of reporting success', async t => {
  t.mock.method(tiltCommands, 'run', async () => { throw new Error('command failed'); });
  await assert.rejects(tiltTransport.trigger('task'), /command failed/);
  await assert.rejects(tiltTransport.logs('task', 'all'), /command failed/);
  t.mock.method(tiltCommands, 'run', async () => 'invalid json');
  await assert.rejects(tiltTransport.logs('task', 'all'), SyntaxError);
});
