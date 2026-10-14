import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { MAX_DIAGNOSTIC_BYTES, startTiltProcess, TiltStartupError } from '../../tilt/process.js';

class FakeTiltChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 12345;
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];
  onKill?: (signal?: NodeJS.Signals | number) => void;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.onKill?.(signal);
    return true;
  }
}

function fixture(spawnError?: Error) {
  const child = new FakeTiltChild();
  const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const forwarded: Buffer[] = [];
  const fakeSpawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    queueMicrotask(() => {
      if (spawnError) {
        child.emit('error', spawnError);
        child.emit('close', null, null);
      } else {
        child.emit('spawn');
      }
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return {
    child,
    calls,
    forwarded,
    dependencies: {
      spawn: fakeSpawn, forwardOutput: (chunk: Buffer) => { forwarded.push(Buffer.from(chunk)); },
      processGroup: false, graceMs: 50, killMs: 50,
    },
  };
}

test('Tilt process uses only its fixed executable, arguments and managed kubeconfig', async () => {
  const fake = fixture();
  const repoDir = '/repos/wasm-platform';
  const session = await startTiltProcess('wasm-platform', repoDir, fake.dependencies);
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.command, 'tilt');
  assert.deepEqual(call.args, ['up', '--stream', '--port', '10350', '--context', 'k3d-wasm-platform']);
  assert.equal(call.options.cwd, repoDir);
  assert.equal(call.options.env?.KUBECONFIG, join(homedir(), '.scratch', 'wasm-platform.yaml'));
  assert.equal(call.options.env?.PATH, process.env.PATH);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  const diagnostic = session.diagnostics(MAX_DIAGNOSTIC_BYTES);
  assert.equal(diagnostic.status, 'running');
  assert.equal(diagnostic.pid, fake.child.pid);
  assert.ok(Number.isFinite(Date.parse(diagnostic.startedAt)));
  assert.equal(session.running, true);
});

test('stdout and stderr remain available after a crash and final output drains before close', async () => {
  const fake = fixture();
  const session = await startTiltProcess('db-operator', '/repos/db-operator', fake.dependencies);
  fake.child.stdout.write(Buffer.from('startup\n'));
  fake.child.stderr.write(Buffer.from('panic: failed\n'));
  fake.child.emit('exit', 2, null);
  const atExit = session.diagnostics(MAX_DIAGNOSTIC_BYTES);
  assert.equal(session.running, false);
  assert.equal(atExit.status, 'exited');
  assert.equal(atExit.exitCode, 2);
  assert.equal(atExit.signal, null);
  assert.ok(Number.isFinite(Date.parse(atExit.exitedAt!)));
  fake.child.stderr.write(Buffer.from('final stack frame\n'));
  fake.child.emit('close', 2, null);
  const diagnostic = session.diagnostics(MAX_DIAGNOSTIC_BYTES);
  const expected = 'startup\npanic: failed\nfinal stack frame\n';
  assert.equal(diagnostic.output.text, expected);
  assert.equal(diagnostic.output.retainedBytes, Buffer.byteLength(expected));
  assert.equal(diagnostic.output.droppedBytes, 0);
  assert.equal(Buffer.concat(fake.forwarded).toString(), expected);
  assert.equal(atExit.output.text, 'startup\npanic: failed\n');
  await session.stop();
  assert.deepEqual(fake.child.signals, []);
});

test('a signal crash reports the signal independently of its exit code', async () => {
  const fake = fixture();
  const session = await startTiltProcess('wasm-platform', '/repos/wasm-platform', fake.dependencies);
  fake.child.emit('exit', null, 'SIGSEGV');
  fake.child.emit('close', null, 'SIGSEGV');
  const diagnostic = session.diagnostics(100);
  assert.equal(diagnostic.status, 'exited');
  assert.equal(diagnostic.exitCode, null);
  assert.equal(diagnostic.signal, 'SIGSEGV');
  assert.equal(session.running, false);
});

test('stop sends SIGINT, waits for close, and preserves the requested-stop diagnostics', async () => {
  const fake = fixture();
  const session = await startTiltProcess('db-operator', '/repos/db-operator', fake.dependencies);
  fake.child.stdout.write(Buffer.from('ready\n'));
  let completed = false;
  const stopping = session.stop().then(() => { completed = true; });
  assert.deepEqual(fake.child.signals, ['SIGINT']);
  fake.child.emit('exit', null, 'SIGINT');
  fake.child.stderr.write(Buffer.from('shutting down\n'));
  await Promise.resolve();
  assert.equal(completed, false);
  fake.child.emit('close', null, 'SIGINT');
  await stopping;
  const diagnostic = session.diagnostics(100);
  assert.equal(diagnostic.status, 'stopped');
  assert.equal(diagnostic.signal, 'SIGINT');
  assert.equal(diagnostic.output.text, 'ready\nshutting down\n');
  assert.equal(session.running, false);
  await session.stop();
  assert.deepEqual(fake.child.signals, ['SIGINT']);
});

test('failed spawn remains inspectable and stopping it does not send a signal', async () => {
  const fake = fixture(new Error('spawn tilt ENOENT'));
  const session = await startTiltProcess('wasm-platform', '/repos/wasm-platform', fake.dependencies);
  const diagnostic = session.diagnostics(100);
  assert.equal(diagnostic.status, 'failed');
  assert.equal(diagnostic.error, 'spawn tilt ENOENT');
  assert.ok(Number.isFinite(Date.parse(diagnostic.exitedAt!)));
  assert.equal(session.running, false);
  await session.stop();
  assert.deepEqual(fake.child.signals, []);
});

test('post-spawn errors stay handled and recorded without falsely reporting process exit', async () => {
  const fake = fixture();
  const session = await startTiltProcess('wasm-platform', '/repos/wasm-platform', fake.dependencies);
  assert.doesNotThrow(() => fake.child.emit('error', new Error('kill EPERM')));
  assert.equal(session.diagnostics(100).error, 'kill EPERM');
  assert.equal(session.running, true);
  assert.doesNotThrow(() => fake.child.emit('error', new Error('x'.repeat(10_000))));
  assert.ok(session.diagnostics(100).error!.length <= 1024);
  fake.child.emit('exit', 1, null);
  fake.child.emit('close', 1, null);
  assert.equal(session.diagnostics(100).status, 'exited');
  assert.ok(session.diagnostics(100).error!.length <= 1024);
});

test('a huge chunk and later crash output retain only a bounded tail with accurate byte counts', async () => {
  const fake = fixture();
  const session = await startTiltProcess('db-operator', '/repos/db-operator', fake.dependencies);
  const huge = Buffer.alloc(MAX_DIAGNOSTIC_BYTES * 8 + 19, 'x');
  const crash = Buffer.from('\npanic\n');
  fake.child.stdout.write(huge);
  fake.child.stderr.write(crash);
  const totalBytes = huge.length + crash.length;
  const full = session.diagnostics(MAX_DIAGNOSTIC_BYTES);
  assert.equal(Buffer.byteLength(full.output.text), MAX_DIAGNOSTIC_BYTES);
  assert.equal(full.output.retainedBytes, MAX_DIAGNOSTIC_BYTES);
  assert.equal(full.output.droppedBytes, totalBytes - MAX_DIAGNOSTIC_BYTES);
  assert.ok(full.output.text.endsWith(crash.toString()));
  const small = session.diagnostics(crash.length);
  assert.equal(small.output.text, crash.toString());
  assert.equal(small.output.retainedBytes, crash.length);
  assert.equal(small.output.droppedBytes, totalBytes - crash.length);
  assert.equal(Buffer.concat(fake.forwarded).length, totalBytes);
});

test('split Unicode chunks are decoded after completion and byte tails omit partial leading characters', async () => {
  const fake = fixture();
  const session = await startTiltProcess('wasm-platform', '/repos/wasm-platform', fake.dependencies);
  const text = Buffer.from('prefix: 🦀€!');
  const crabStart = Buffer.byteLength('prefix: ');
  fake.child.stdout.write(text.subarray(0, crabStart + 2));
  fake.child.stdout.write(text.subarray(crabStart + 2));
  const complete = session.diagnostics(MAX_DIAGNOSTIC_BYTES);
  assert.equal(complete.output.text, 'prefix: 🦀€!');
  assert.equal(complete.output.retainedBytes, text.length);
  assert.equal(complete.output.droppedBytes, 0);
  const tail = session.diagnostics(3);
  assert.equal(tail.output.text, '!');
  assert.equal(tail.output.retainedBytes, 1);
  assert.equal(tail.output.droppedBytes, text.length - 1);
  assert.equal(Buffer.byteLength(tail.output.text), tail.output.retainedBytes);
});

test('interleaved stdout and stderr preserve independently split Unicode characters', async () => {
  const fake = fixture();
  const session = await startTiltProcess('wasm-platform', '/repos/wasm-platform', fake.dependencies);
  const stdout = Buffer.from('prefix: 🦀done\n');
  const split = Buffer.byteLength('prefix: ') + 2;
  fake.child.stdout.write(stdout.subarray(0, split));
  fake.child.stderr.write(Buffer.from('panic\n'));
  fake.child.stdout.write(stdout.subarray(split));
  const diagnostic = session.diagnostics(MAX_DIAGNOSTIC_BYTES);
  assert.equal(diagnostic.output.text, 'prefix: panic\n🦀done\n');
  assert.ok(!diagnostic.output.text.includes('\ufffd'));
  assert.equal(diagnostic.output.retainedBytes, stdout.length + Buffer.byteLength('panic\n'));
  assert.equal(diagnostic.output.droppedBytes, 0);
});

test('retention at its byte cap discards a partial Unicode prefix without replacement characters', async () => {
  const fake = fixture();
  const session = await startTiltProcess('db-operator', '/repos/db-operator', fake.dependencies);
  const bytes = Buffer.from('🦀'.repeat(MAX_DIAGNOSTIC_BYTES / 4 + 1) + '!');
  fake.child.stderr.write(bytes);
  const diagnostic = session.diagnostics(MAX_DIAGNOSTIC_BYTES);
  assert.ok(!diagnostic.output.text.includes('\ufffd'));
  assert.ok(diagnostic.output.text.endsWith('🦀!'));
  assert.ok(diagnostic.output.retainedBytes <= MAX_DIAGNOSTIC_BYTES);
  assert.equal(Buffer.byteLength(diagnostic.output.text), diagnostic.output.retainedBytes);
  assert.equal(diagnostic.output.droppedBytes, bytes.length - diagnostic.output.retainedBytes);
});

test('callers cannot mutate retained diagnostics through a returned snapshot', async () => {
  const fake = fixture();
  const session = await startTiltProcess('db-operator', '/repos/db-operator', fake.dependencies);
  fake.child.stderr.write(Buffer.from('original\n'));
  const previous = session.diagnostics(100);
  previous.status = 'failed';
  previous.output.text = 'modified';
  previous.output.droppedBytes = 999;
  const current = session.diagnostics(100);
  assert.equal(current.status, 'running');
  assert.equal(current.output.text, 'original\n');
  assert.equal(current.output.droppedBytes, 0);
});

test('diagnostics rejects invalid byte limits before reading retained output', async () => {
  const fake = fixture();
  const session = await startTiltProcess('wasm-platform', '/repos/wasm-platform', fake.dependencies);
  for (const maxBytes of [0, -1, 1.5, MAX_DIAGNOSTIC_BYTES + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => session.diagnostics(maxBytes), /maxBytes must be an integer/);
  }
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.child.signals, []);
});

test('stalled Tilt shutdown coalesces stops and escalates SIGINT to SIGKILL with diagnostics retained', async () => {
  const fake = fixture();
  fake.child.onKill = signal => {
    if (signal !== 'SIGKILL') return;
    fake.child.stderr.write(Buffer.from('forced shutdown\n'));
    fake.child.emit('exit', null, 'SIGKILL');
    fake.child.emit('close', null, 'SIGKILL');
  };
  const session = await startTiltProcess('wasm-platform', '/repos/wasm-platform', { ...fake.dependencies, graceMs: 5 });
  const first = session.stop();
  const second = session.stop();
  assert.equal(first, second);
  await first;
  assert.deepEqual(fake.child.signals, ['SIGINT', 'SIGKILL']);
  assert.equal(session.diagnostics(100).status, 'stopped');
  assert.equal(session.diagnostics(100).signal, 'SIGKILL');
  assert.equal(session.diagnostics(100).output.text, 'forced shutdown\n');
});

test('failed Tilt shutdown remains inspectable and can be retried through its retained session', async () => {
  const fake = fixture();
  const session = await startTiltProcess('wasm-platform', '/repos/wasm-platform', { ...fake.dependencies, graceMs: 5, killMs: 5 });
  fake.child.stderr.write(Buffer.from('stalled\n'));
  await assert.rejects(session.stop(), /did not close after forced shutdown/);
  assert.equal(session.running, true);
  assert.equal(session.diagnostics(100).output.text, 'stalled\n');
  fake.child.onKill = signal => {
    fake.child.emit('exit', null, signal);
    fake.child.emit('close', null, signal);
  };
  await session.stop();
  assert.equal(session.running, false);
  assert.deepEqual(fake.child.signals, ['SIGINT', 'SIGKILL', 'SIGINT']);
});

test('cancelled Tilt startup does not spawn when cancellation was already requested', async () => {
  const fake = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(startTiltProcess('wasm-platform', '/repos/wasm-platform', { ...fake.dependencies, signal: controller.signal }), /startup cancelled/);
  assert.equal(fake.calls.length, 0);
});

test('cancelling Tilt startup cleans up a child whose spawn notification arrives late', async () => {
  const fake = fixture();
  fake.child.pid = undefined;
  fake.child.onKill = signal => {
    fake.child.emit('exit', null, signal);
    fake.child.emit('close', null, signal);
  };
  const controller = new AbortController();
  const delayedSpawn = (() => fake.child as unknown as ChildProcess) as unknown as typeof spawn;
  const starting = startTiltProcess('wasm-platform', '/repos/wasm-platform', { ...fake.dependencies, spawn: delayedSpawn, signal: controller.signal });
  const rejected = assert.rejects(starting, /startup cancelled/);
  controller.abort();
  await Promise.resolve();
  fake.child.pid = 12345;
  fake.child.emit('spawn');
  await rejected;
  assert.deepEqual(fake.child.signals, ['SIGINT']);
});

test('a Tilt child that never acknowledges spawn has a bounded startup deadline and cleanup', async () => {
  const fake = fixture();
  fake.child.onKill = signal => {
    fake.child.emit('exit', null, signal);
    fake.child.emit('close', null, signal);
  };
  const stalledSpawn = (() => fake.child as unknown as ChildProcess) as unknown as typeof spawn;
  await assert.rejects(startTiltProcess('wasm-platform', '/repos/wasm-platform', { ...fake.dependencies, spawn: stalledSpawn, startupMs: 5 }), /startup timed out/);
  assert.deepEqual(fake.child.signals, ['SIGINT']);
  assert.equal(fake.child.listenerCount('spawn'), 0);
});

test('cleanup-failed Tilt startup returns a typed error carrying its inspectable, retryable session', async () => {
  const fake = fixture();
  const stalledSpawn = (() => fake.child as unknown as ChildProcess) as unknown as typeof spawn;
  let failure!: TiltStartupError;
  await assert.rejects(startTiltProcess('wasm-platform', '/repos/wasm-platform', { ...fake.dependencies, spawn: stalledSpawn, startupMs: 5, graceMs: 5, killMs: 5 }), error => {
    assert.ok(error instanceof TiltStartupError);
    failure = error;
    assert.equal(error.message, 'Tilt startup cleanup failed');
    return true;
  });
  assert.equal(failure.session.running, true);
  fake.child.stderr.write(Buffer.from('cleanup failed\n'));
  assert.equal(failure.session.diagnostics(100).output.text, 'cleanup failed\n');
  fake.child.onKill = signal => {
    fake.child.emit('exit', null, signal);
    fake.child.emit('close', null, signal);
  };
  await failure.session.stop();
  assert.equal(failure.session.running, false);
});

test('Tilt output stream errors are handled, bounded in diagnostics and clean up the managed child', async () => {
  const fake = fixture();
  fake.child.onKill = signal => {
    fake.child.emit('exit', null, signal);
    fake.child.emit('close', null, signal);
  };
  const session = await startTiltProcess('wasm-platform', '/repos/wasm-platform', fake.dependencies);
  fake.child.stderr.write(Buffer.from('last diagnostic\n'));
  assert.doesNotThrow(() => fake.child.stdout.emit('error', new Error('x'.repeat(5000))));
  await session.stop();
  const diagnostic = session.diagnostics(100);
  assert.equal(diagnostic.status, 'stopped');
  assert.equal(diagnostic.error?.length, 1024);
  assert.equal(diagnostic.output.text, 'last diagnostic\n');
  assert.deepEqual(fake.child.signals, ['SIGINT']);
  assert.doesNotThrow(() => fake.child.stderr.emit('error', new Error('later stream failure')));
});
