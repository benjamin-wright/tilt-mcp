import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  createManagedCommandRunner, stopManagedProcess, trackManagedProcess,
  MAX_MANAGED_STDOUT_BYTES, PROCESS_GRACE_MS, PROCESS_KILL_MS,
} from '../../process.js';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 12345;
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];
  onKill?: (signal?: NodeJS.Signals | number) => void;
  failKill = false;
  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.failKill) throw new Error('SENSITIVE-CREDENTIAL permission denied');
    this.signals.push(signal);
    this.onKill?.(signal);
    return true;
  }
  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function fixture(overrides: { timeoutMs?: number; graceMs?: number; killMs?: number; processGroup?: boolean } = {}) {
  const child = new FakeChild();
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const fakeSpawn = ((command: string, args: string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  const run = createManagedCommandRunner({ spawn: fakeSpawn, processGroup: false, timeoutMs: 1000, graceMs: 10, killMs: 20, ...overrides });
  return { child, calls, run };
}

test('managed commands spawn argv without a shell and return bounded stdout only after close', async () => {
  const fake = fixture();
  const waiting = fake.run('make', ['-C', '/repos/wasm-platform', 'cluster-up'], '/repos/wasm-platform');
  assert.deepEqual(fake.calls, [{ command: 'make', args: ['-C', '/repos/wasm-platform', 'cluster-up'], options: { cwd: '/repos/wasm-platform', detached: false, stdio: ['ignore', 'pipe', 'pipe'] } }]);
  fake.child.stdout.write(Buffer.from('one\n'));
  fake.child.stdout.write(Buffer.from('two\n'));
  fake.child.finish();
  assert.equal(await waiting, 'one\ntwo\n');
  assert.deepEqual(fake.child.signals, []);
});

test('command failures retain a bounded stderr count without returning stderr credentials', async () => {
  const fake = fixture();
  const waiting = fake.run('make', ['cluster-up']);
  fake.child.stderr.write(Buffer.from('SENSITIVE-CREDENTIAL'.repeat(100_000)));
  fake.child.finish(2);
  await assert.rejects(waiting, error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Managed command failed (exit code 2; 16384 retained stderr bytes)');
    return true;
  });
});

test('command cancellation waits for child cleanup before rejecting and removes the abort listener', async () => {
  const fake = fixture();
  const controller = new AbortController();
  const waiting = fake.run('make', ['cluster-up'], undefined, controller.signal);
  const rejected = assert.rejects(waiting, /Managed command cancelled/);
  controller.abort(new Error('SENSITIVE-CREDENTIAL'));
  assert.deepEqual(fake.child.signals, ['SIGTERM']);
  fake.child.finish(null, 'SIGTERM');
  await rejected;
  controller.abort();
  assert.deepEqual(fake.child.signals, ['SIGTERM']);
});

test('an already cancelled command never spawns', async () => {
  const fake = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fake.run('make', [], undefined, controller.signal), /cancelled/);
  assert.equal(fake.calls.length, 0);
});

test('a timed out command escalates to SIGKILL and completes within its bounded cleanup deadline', async () => {
  const fake = fixture({ timeoutMs: 5, graceMs: 5 });
  fake.child.onKill = signal => { if (signal === 'SIGKILL') fake.child.finish(null, 'SIGKILL'); };
  await assert.rejects(fake.run('make', ['cluster-up']), /Managed command timed out/);
  assert.deepEqual(fake.child.signals, ['SIGTERM', 'SIGKILL']);
});

test('stdout overflow cancels the owned command without exposing oversized output', async () => {
  const fake = fixture();
  fake.child.onKill = signal => { fake.child.finish(null, signal as NodeJS.Signals); };
  const waiting = fake.run('k3d', ['cluster', 'list']);
  fake.child.stdout.write(Buffer.alloc(MAX_MANAGED_STDOUT_BYTES + 1));
  await assert.rejects(waiting, /stdout exceeds the size limit/);
  assert.deepEqual(fake.child.signals, ['SIGTERM']);
});

test('concurrent stops share one promise and send one graceful signal', async () => {
  const child = new FakeChild();
  trackManagedProcess(child as unknown as ChildProcess);
  const options = { processGroup: false, graceMs: 20, killMs: 20 };
  const first = stopManagedProcess(child as unknown as ChildProcess, options);
  const second = stopManagedProcess(child as unknown as ChildProcess, options);
  assert.equal(first, second);
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.finish(null, 'SIGTERM');
  await first;
  await stopManagedProcess(child as unknown as ChildProcess, options);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('an unresponsive process produces a finite error and temporary stop listeners are removed', async () => {
  const child = new FakeChild();
  await assert.rejects(stopManagedProcess(child as unknown as ChildProcess, { processGroup: false, graceMs: 5, killMs: 5 }), /did not close after forced shutdown/);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.listenerCount('spawn'), 0);
  assert.equal(child.listenerCount('close'), 1);
  child.finish(null, 'SIGKILL');
  await stopManagedProcess(child as unknown as ChildProcess, { processGroup: false, graceMs: 5, killMs: 5 });
});

test('failed signalling is safe and leaves the process available for a later stop retry', async () => {
  const child = new FakeChild();
  child.failKill = true;
  await assert.rejects(stopManagedProcess(child as unknown as ChildProcess, { graceMs: 5, killMs: 5 }), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Could not signal managed process');
    return true;
  });
  assert.doesNotThrow(() => child.emit('error', new Error('late error')));
  child.failKill = false;
  child.onKill = signal => child.finish(null, signal as NodeJS.Signals);
  await stopManagedProcess(child as unknown as ChildProcess, { graceMs: 5, killMs: 5 });
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('a child that exits before its streams close is drained without signalling its exited PID', async () => {
  const child = new FakeChild();
  trackManagedProcess(child as unknown as ChildProcess);
  child.emit('exit', 0, null);
  const stopping = stopManagedProcess(child as unknown as ChildProcess, { graceMs: 20, killMs: 20 });
  child.emit('close', 0, null);
  await stopping;
  assert.deepEqual(child.signals, []);
});

test('failed spawn and output stream errors are handled without raw platform error text', async () => {
  const fake = fixture();
  fake.child.onKill = signal => fake.child.finish(null, signal as NodeJS.Signals);
  const waiting = fake.run('make', []);
  fake.child.emit('error', new Error('SENSITIVE-CREDENTIAL'));
  await assert.rejects(waiting, /Managed command process failed/);
  assert.doesNotThrow(() => fake.child.emit('error', new Error('another platform error')));
  const stream = fixture();
  stream.child.onKill = signal => stream.child.finish(null, signal as NodeJS.Signals);
  const reading = stream.run('make', []);
  stream.child.stdout.emit('error', new Error('SENSITIVE-CREDENTIAL'));
  await assert.rejects(reading, /output stream failed/);
});

test('test deadlines may be reduced but fixed shutdown limits cannot be enlarged', () => {
  const child = new FakeChild();
  for (const options of [{ graceMs: 0 }, { graceMs: PROCESS_GRACE_MS + 1 }, { killMs: PROCESS_KILL_MS + 1 }, { killMs: NaN }]) {
    assert.throws(() => stopManagedProcess(child as unknown as ChildProcess, options), /fixed maximums/);
  }
  assert.throws(() => createManagedCommandRunner({ timeoutMs: 300_001 }), /fixed maximums/);
});

test('retained process handles never signal a group after its disappearance even if its ID is reused', async t => {
  const child = new FakeChild();
  let exists = false;
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(pid, -child.pid!);
    signals.push(signal);
    if (!exists) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  trackManagedProcess(child as unknown as ChildProcess, { processGroup: true, graceMs: 5, killMs: 5 });
  child.finish(1);
  assert.deepEqual(signals, [0]);
  exists = true;
  await stopManagedProcess(child as unknown as ChildProcess, { processGroup: true, graceMs: 5, killMs: 5 });
  assert.deepEqual(signals, [0], 'the recycled process group must never be probed or signalled');
});

test('successful command completion waits for cleanup of its remaining owned descendants', async t => {
  const fake = fixture({ processGroup: true, graceMs: 5, killMs: 5 });
  let exists = true;
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  t.mock.method(process, 'kill', (_pid: number, signal?: NodeJS.Signals | number) => {
    if (!exists) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    if (signal !== 0) signals.push(signal);
    if (signal === 'SIGKILL') exists = false;
    return true;
  });
  const waiting = fake.run('make', ['cluster-up']);
  fake.child.stdout.write(Buffer.from('ready\n'));
  fake.child.finish(0);
  assert.equal(await waiting, 'ready\n');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('cancelling a real process group kills a stalled grandchild even after its parent exits', { skip: process.platform === 'win32', timeout: 5000 }, async t => {
  const controller = new AbortController();
  let child: ChildProcess | undefined;
  let grandchildPid = 0;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const script = `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    descendant.once('message', () => { process.stdout.write(String(descendant.pid) + '\\n'); descendant.disconnect(); });
    setInterval(() => {}, 1000);
  `;
  const observedSpawn = ((command: string, args: string[], options: SpawnOptions) => {
    child = spawn(command, args, options);
    child.stdout?.once('data', (chunk: Buffer) => { grandchildPid = Number(chunk.toString().trim()); ready(); });
    return child;
  }) as unknown as typeof spawn;
  t.after(() => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } });
  const run = createManagedCommandRunner({ spawn: observedSpawn, graceMs: 100, killMs: 1000, timeoutMs: 3000 });
  const waiting = run(process.execPath, ['-e', script], undefined, controller.signal);
  const rejected = assert.rejects(waiting, /Managed command cancelled/);
  await started;
  assert.ok(grandchildPid > 0);
  controller.abort();
  await rejected;
  assert.ok(child?.signalCode === 'SIGTERM', 'the leader exits during graceful shutdown');
  const deadline = Date.now() + 1000;
  let alive = true;
  while (Date.now() < deadline) {
    try { process.kill(grandchildPid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { alive = false; break; } throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(alive, false, 'the descendant must not survive command cancellation');
});
