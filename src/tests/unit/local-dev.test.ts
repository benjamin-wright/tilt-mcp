import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalDev, type Environment, type TiltSession } from '../../local-dev.js';
import { TiltStartupError, type TiltProcessDiagnostics } from '../../tilt/process.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function managedSession(environment: Environment) {
  let status: TiltProcessDiagnostics['status'] = 'running';
  const item = { environment, stops: 0, session: undefined as unknown as TiltSession, crash() { status = 'exited'; } };
  item.session = {
    get running() { return status === 'running'; },
    diagnostics: () => ({ status, startedAt: '2026-10-13T12:00:00.000Z', exitCode: status === 'exited' ? 2 : undefined, output: { text: 'Tilt console', retainedBytes: 12, droppedBytes: 0 } }),
    stop: async () => { item.stops++; if (status === 'running') status = 'stopped'; },
  };
  return item;
}

function fixture(initial: { name: string; serversCount: number; serversRunning: number }[] = []) {
  let clusters = [...initial];
  const calls: string[][] = [];
  const sessions: ReturnType<typeof managedSession>[] = [];
  const dev = new LocalDev({
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'k3d') return JSON.stringify(clusters);
      const environment = args[1].split('/').at(-1)!;
      if (args.at(-1) === 'cluster-up') clusters.push({ name: environment, serversCount: 1, serversRunning: 1 });
      else clusters = clusters.filter(cluster => cluster.name !== environment);
      return '';
    },
    startTilt: async environment => {
      const item = managedSession(environment);
      sessions.push(item);
      return item.session;
    },
  });
  return { dev, calls, sessions };
}

test('MVP starts selected cluster and owns one Tilt session', async () => {
  const fake = fixture();
  assert.deepEqual(await fake.dev.execute('wasm-platform', 'start'), { environment: 'wasm-platform', status: 'running', tiltUrl: 'http://localhost:10350' });
  assert.equal(fake.calls[1].at(-1), 'cluster-up');
  assert.match(fake.calls[1][2], /\/wasm-platform$/);
  assert.equal(fake.sessions.length, 1);
});

test('MVP repeat start reuses the live in-memory session without another make', async () => {
  const fake = fixture();
  await fake.dev.execute('wasm-platform', 'start');
  const previousCalls = fake.calls.length;
  await fake.dev.execute('wasm-platform', 'start');
  assert.equal(fake.calls.length, previousCalls);
  assert.equal(fake.sessions.length, 1);
});

test('MVP switch stops previous Tilt and tears down only the counterpart cluster', async () => {
  const fake = fixture([{ name: 'unrelated', serversCount: 1, serversRunning: 1 }]);
  await fake.dev.execute('wasm-platform', 'start');
  await fake.dev.execute('db-operator', 'start');
  assert.equal(fake.sessions[0].stops, 1);
  const downs = fake.calls.filter(call => call.at(-1) === 'cluster-down');
  assert.equal(downs.length, 1);
  assert.match(downs[0][2], /\/wasm-platform$/);
  assert.equal(fake.sessions[1].environment, 'db-operator');
});

test('MVP stop shuts down its Tilt session and deletes selected cluster idempotently', async () => {
  const fake = fixture();
  await fake.dev.execute('db-operator', 'start');
  assert.equal((await fake.dev.execute('db-operator', 'stop')).status, 'stopped');
  assert.equal(fake.sessions[0].stops, 1);
  assert.equal((await fake.dev.execute('db-operator', 'stop')).status, 'absent');
  assert.equal(fake.calls.filter(call => call.at(-1) === 'cluster-down').length, 1);
});

test('MVP close stops the retained Tilt session and leaves cluster teardown explicit', async () => {
  const fake = fixture();
  await fake.dev.execute('wasm-platform', 'start');
  await fake.dev.close();
  await fake.dev.close();
  assert.equal(fake.sessions[0].stops, 1);
  assert.equal(fake.calls.filter(call => call.at(-1) === 'cluster-down').length, 0);
  await assert.rejects(fake.dev.execute('wasm-platform', 'start'), /closed/);
});

test('MVP failed cluster setup never launches Tilt', async () => {
  let launches = 0;
  const dev = new LocalDev({ run: async command => { if (command === 'k3d') return '[]'; throw new Error('make failed'); }, startTilt: async () => { launches++; throw new Error('should not run'); } });
  await assert.rejects(dev.execute('wasm-platform', 'start'), /make failed/);
  assert.equal(launches, 0);
});

test('close bounds an uncooperative setup wait and prevents an orphan Tilt launch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered!: () => void, finish!: () => void, launches = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const setup = new Promise<void>(resolve => { finish = resolve; });
  const dev = new LocalDev({ run: async command => { if (command === 'k3d') return '[]'; entered(); await setup; return ''; }, startTilt: async () => { launches++; throw new Error('should not run'); } });
  const pending = dev.execute('wasm-platform', 'start');
  const rejected = assert.rejects(pending, /closed/);
  await ready;
  const closing = dev.close();
  t.mock.timers.tick(8_000);
  await closing;
  finish();
  await rejected;
  assert.equal(launches, 0);
});

test('MVP rejects overlapping calls so one session handle cannot overwrite another', async () => {
  let entered!: () => void, finish!: () => void, launches = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const setup = new Promise<void>(resolve => { finish = resolve; });
  const dev = new LocalDev({
    run: async command => { if (command === 'k3d') return '[]'; entered(); await setup; return ''; },
    startTilt: async () => { launches++; return { running: true, diagnostics: () => ({ status: 'running', startedAt: '', output: { text: '', retainedBytes: 0, droppedBytes: 0 } }), stop: async () => {} }; },
  });
  const pending = dev.execute('wasm-platform', 'start');
  await ready;
  await assert.rejects(dev.execute('db-operator', 'start'), /in progress/);
  finish();
  await pending;
  assert.equal(launches, 1);
  await dev.close();
});

test('MVP reuses a running cluster and rebuilds a stopped cluster', async () => {
  const running = fixture([{ name: 'wasm-platform', serversCount: 1, serversRunning: 1 }]);
  await running.dev.execute('wasm-platform', 'start');
  assert.equal(running.calls.filter(call => call[0] === 'make').length, 0);
  const stopped = fixture([{ name: 'db-operator', serversCount: 1, serversRunning: 0 }]);
  await stopped.dev.execute('db-operator', 'start');
  assert.deepEqual(stopped.calls.filter(call => call[0] === 'make').map(call => call.at(-1)), ['cluster-down', 'cluster-up']);
});

test('diagnostics is available before start and performs no external operations', () => {
  const fake = fixture();
  assert.deepEqual(fake.dev.diagnostics('wasm-platform'), {
    environment: 'wasm-platform', status: 'not_started', output: { text: '', retainedBytes: 0, droppedBytes: 0 },
  });
  assert.equal(fake.calls.length, 0);
  assert.throws(() => fake.dev.diagnostics('production' as Environment), /Expected/);
  for (const maxBytes of [0, -1, 1.5, 65_537, Infinity, NaN]) assert.throws(() => fake.dev.diagnostics('wasm-platform', maxBytes), /maxBytes/);
});

test('crash diagnostics survives stop, environment switch and MCP close', async () => {
  const fake = fixture();
  await fake.dev.execute('wasm-platform', 'start');
  fake.sessions[0].crash();
  const previousCalls = fake.calls.length;
  const crash = fake.dev.diagnostics('wasm-platform');
  assert.equal(crash.status, 'exited');
  assert.equal(crash.output.text, 'Tilt console');
  assert.ok('exitCode' in crash);
  assert.equal(crash.exitCode, 2);
  assert.equal(fake.calls.length, previousCalls);
  await fake.dev.execute('wasm-platform', 'stop');
  assert.deepEqual(fake.dev.diagnostics('wasm-platform'), crash);
  await fake.dev.execute('db-operator', 'start');
  assert.deepEqual(fake.dev.diagnostics('wasm-platform'), crash);
  assert.equal(fake.dev.diagnostics('db-operator').status, 'running');
  await fake.dev.close();
  assert.deepEqual(fake.dev.diagnostics('wasm-platform'), crash);
  assert.equal(fake.dev.diagnostics('db-operator').status, 'stopped');
});

test('restarting an exited environment replaces its record and reuses its cluster', async () => {
  const fake = fixture();
  await fake.dev.execute('wasm-platform', 'start');
  fake.sessions[0].crash();
  await fake.dev.execute('wasm-platform', 'start');
  assert.equal(fake.sessions.length, 2);
  assert.equal(fake.dev.diagnostics('wasm-platform').status, 'running');
  assert.equal(fake.calls.filter(call => call.at(-1) === 'cluster-up').length, 1);
});

test('failed Tilt spawn stays diagnosable and start reports an error', async () => {
  const failed: TiltProcessDiagnostics = { status: 'failed', startedAt: '2026-10-13T12:00:00.000Z', error: 'spawn tilt ENOENT', output: { text: '', retainedBytes: 0, droppedBytes: 0 } };
  const dev = new LocalDev({ run: async () => '[{"name":"wasm-platform","serversCount":1,"serversRunning":1}]', startTilt: async () => ({ running: false, diagnostics: () => failed, stop: async () => {} }) });
  await assert.rejects(dev.execute('wasm-platform', 'start'), /local_dev_diagnostics/);
  assert.deepEqual(dev.diagnostics('wasm-platform'), { environment: 'wasm-platform', ...failed });
});

test('stop cancels same-environment setup, awaits cleanup, coalesces and then tears down the cluster', async () => {
  const entered = deferred<void>();
  const aborted = deferred<void>();
  const cleanup = deferred<void>();
  const teardownEntered = deferred<void>();
  const finishTeardown = deferred<void>();
  const calls: string[] = [];
  let setupSignal: AbortSignal | undefined;
  let launches = 0;
  let lists = 0;
  const dev = new LocalDev({
    run: async (command, args, _cwd, signal) => {
      calls.push(command === 'k3d' ? 'list' : args.at(-1)!);
      if (command === 'k3d') return lists++ === 0 ? '[]' : '[{"name":"wasm-platform","serversCount":1,"serversRunning":1}]';
      if (args.at(-1) === 'cluster-up') {
        setupSignal = signal;
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener('abort', () => {
            aborted.resolve();
            void cleanup.promise.then(() => { calls.push('setup-cleaned'); reject(signal!.reason); });
          }, { once: true });
        });
      } else {
        teardownEntered.resolve();
        await finishTeardown.promise;
      }
      return '';
    },
    startTilt: async () => { launches++; throw new Error('should not launch'); },
  });
  const start = dev.execute('wasm-platform', 'start');
  const rejectedStart = assert.rejects(start, /cancelled by stop/);
  await entered.promise;
  const stop = dev.execute('wasm-platform', 'stop');
  await aborted.promise;
  assert.equal(setupSignal?.aborted, true);
  assert.deepEqual(calls, ['list', 'cluster-up']);
  cleanup.resolve();
  await rejectedStart;
  await teardownEntered.promise;
  await assert.rejects(dev.execute('wasm-platform', 'start'), /in progress/);
  await assert.rejects(dev.execute('db-operator', 'stop'), /in progress/);
  const coalescedStop = dev.execute('wasm-platform', 'stop');
  finishTeardown.resolve();
  assert.deepEqual(await stop, { environment: 'wasm-platform', status: 'stopped' });
  assert.deepEqual(await coalescedStop, await stop);
  assert.deepEqual(calls, ['list', 'cluster-up', 'setup-cleaned', 'list', 'cluster-down']);
  assert.equal(launches, 0);
  await dev.close();
});

test('a late uncooperative setup cannot launch Tilt after stop completes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred<void>();
  const finish = deferred<void>();
  let lists = 0;
  let launches = 0;
  let downs = 0;
  const dev = new LocalDev({
    run: async (command, args) => {
      if (command === 'k3d') return lists++ === 0 ? '[]' : '[{"name":"wasm-platform","serversCount":1,"serversRunning":1}]';
      if (args.at(-1) === 'cluster-up') { entered.resolve(); await finish.promise; }
      else downs++;
      return '';
    },
    startTilt: async () => { launches++; throw new Error('should not launch'); },
  });
  const pending = dev.execute('wasm-platform', 'start');
  const rejected = assert.rejects(pending, /cancelled by stop/);
  await entered.promise;
  const stopped = dev.execute('wasm-platform', 'stop');
  t.mock.timers.tick(8_000);
  assert.equal((await stopped).status, 'stopped');
  await rejected;
  finish.resolve();
  await Promise.resolve();
  assert.equal(launches, 0);
  assert.equal(downs, 1);
  await dev.close();
});

test('unrelated or invalid stop requests cannot interrupt the selected start', async () => {
  const entered = deferred<void>();
  const finish = deferred<void>();
  let setupSignal: AbortSignal | undefined;
  const dev = new LocalDev({
    run: async (command, _args, _cwd, signal) => {
      if (command === 'k3d') return '[]';
      setupSignal = signal;
      entered.resolve();
      await finish.promise;
      return '';
    },
    startTilt: async () => { throw new Error('should not launch'); },
  });
  const pending = dev.execute('wasm-platform', 'start');
  const rejected = assert.rejects(pending, /closed/);
  await entered.promise;
  await assert.rejects(dev.execute('db-operator', 'stop'), /in progress/);
  await assert.rejects(dev.execute('production' as Environment, 'stop'), /Expected/);
  await assert.rejects(dev.execute('wasm-platform', 'delete' as 'stop'), /Expected/);
  assert.equal(setupSignal?.aborted, false);
  const closing = dev.close();
  finish.resolve();
  await closing;
  await rejected;
});

test('client cancellation reaches the command signal and prevents later setup steps', async () => {
  const entered = deferred<void>();
  const controller = new AbortController();
  let commandSignal: AbortSignal | undefined;
  const calls: string[] = [];
  const dev = new LocalDev({
    run: async (command, _args, _cwd, signal) => {
      calls.push(command);
      commandSignal = signal;
      entered.resolve();
      return new Promise<string>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    },
    startTilt: async () => { throw new Error('should not launch'); },
  });
  const pending = dev.execute('wasm-platform', 'start', controller.signal);
  const rejected = assert.rejects(pending, /client cancelled/);
  await entered.promise;
  controller.abort(new Error('client cancelled'));
  await rejected;
  assert.equal(commandSignal?.aborted, true);
  assert.deepEqual(calls, ['k3d']);
  await dev.close();
});

test('close aborts an in-flight command and leaves cluster teardown explicit', async () => {
  const entered = deferred<void>();
  let commandSignal: AbortSignal | undefined;
  const calls: string[] = [];
  const dev = new LocalDev({
    run: async (command, _args, _cwd, signal) => {
      calls.push(command);
      commandSignal = signal;
      entered.resolve();
      return new Promise<string>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    },
    startTilt: async () => { throw new Error('should not launch'); },
  });
  const pending = dev.execute('wasm-platform', 'start');
  const rejected = assert.rejects(pending, /closed/);
  await entered.promise;
  await dev.close();
  await rejected;
  assert.equal(commandSignal?.aborted, true);
  assert.deepEqual(calls, ['k3d']);
});

test('a late canceled Tilt launch is stopped without replacing a newer session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred<void>();
  const late = deferred<TiltSession>();
  const oldSession = managedSession('wasm-platform');
  const oldSessionStopped = deferred<void>();
  const stopOldSession = oldSession.session.stop;
  oldSession.session.stop = async () => {
    await stopOldSession();
    oldSessionStopped.resolve();
  };
  const currentSession = managedSession('wasm-platform');
  const controller = new AbortController();
  let launches = 0;
  let launchSignal: AbortSignal | undefined;
  const dev = new LocalDev({
    run: async () => '[{"name":"wasm-platform","serversCount":1,"serversRunning":1}]',
    startTilt: async (_environment, _repoDir, signal) => {
      launchSignal = signal;
      if (++launches === 1) { entered.resolve(); return late.promise; }
      return currentSession.session;
    },
  });
  const pending = dev.execute('wasm-platform', 'start', controller.signal);
  const rejected = assert.rejects(pending, /client cancelled/);
  await entered.promise;
  controller.abort(new Error('client cancelled'));
  assert.equal(launchSignal?.aborted, true);
  t.mock.timers.tick(8_000);
  await rejected;
  await dev.execute('wasm-platform', 'start');
  late.resolve(oldSession.session);
  await oldSessionStopped.promise;
  assert.equal(oldSession.stops, 1);
  assert.equal(currentSession.stops, 0);
  assert.equal(dev.diagnostics('wasm-platform').status, 'running');
  await dev.execute('wasm-platform', 'start');
  assert.equal(launches, 2);
  await dev.close();
  assert.equal(currentSession.stops, 1);
});

test('operation timeout bounds an uncooperative command and prevents Tilt startup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred<void>();
  const finish = deferred<string>();
  let commandSignal: AbortSignal | undefined;
  let launches = 0;
  const dev = new LocalDev({
    run: async (_command, _args, _cwd, signal) => { commandSignal = signal; entered.resolve(); return finish.promise; },
    startTilt: async () => { launches++; throw new Error('should not launch'); },
  });
  const pending = dev.execute('wasm-platform', 'start');
  const rejected = assert.rejects(pending, /timed out after 5 minutes/);
  await entered.promise;
  t.mock.timers.tick(5 * 60_000);
  assert.equal(commandSignal?.aborted, true);
  t.mock.timers.tick(8_000);
  await rejected;
  finish.resolve('[]');
  await Promise.resolve();
  assert.equal(launches, 0);
  await dev.close();
});

test('a failed Tilt stop can be retried without losing its active session', async () => {
  const owned = managedSession('wasm-platform');
  const originalStop = owned.session.stop;
  let attempts = 0;
  owned.session.stop = async () => {
    if (++attempts === 1) throw new Error('Could not signal Tilt');
    await originalStop();
  };
  let downs = 0;
  const dev = new LocalDev({
    run: async (command, args) => {
      if (command === 'k3d') return '[{"name":"wasm-platform","serversCount":1,"serversRunning":1}]';
      if (args.at(-1) === 'cluster-down') downs++;
      return '';
    },
    startTilt: async () => owned.session,
  });
  await dev.execute('wasm-platform', 'start');
  await assert.rejects(dev.execute('wasm-platform', 'stop'), /Could not signal Tilt/);
  assert.equal(dev.diagnostics('wasm-platform').status, 'running');
  assert.equal(downs, 0);
  assert.equal((await dev.execute('wasm-platform', 'stop')).status, 'stopped');
  assert.equal(attempts, 2);
  assert.equal(owned.stops, 1);
  assert.equal(downs, 1);
  await dev.close();
});

test('failed startup cleanup retains Tilt diagnostics and ownership for a later stop', async () => {
  const owned = managedSession('wasm-platform');
  let downs = 0;
  const dev = new LocalDev({
    run: async (command, args) => {
      if (command === 'k3d') return '[{"name":"wasm-platform","serversCount":1,"serversRunning":1}]';
      if (args.at(-1) === 'cluster-down') downs++;
      return '';
    },
    startTilt: async () => { throw new TiltStartupError('Tilt startup cleanup failed', owned.session); },
  });
  await assert.rejects(dev.execute('wasm-platform', 'start'), /startup cleanup failed/);
  assert.equal(dev.diagnostics('wasm-platform').status, 'running');
  assert.equal((await dev.execute('wasm-platform', 'stop')).status, 'stopped');
  assert.equal(owned.stops, 1);
  assert.equal(downs, 1);
  await dev.close();
});
