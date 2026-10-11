import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalDev, type Environment, type TiltSession } from '../../local-dev.js';

function fixture(initial: { name: string; serversCount: number; serversRunning: number }[] = []) {
  let clusters = [...initial];
  const calls: string[][] = [];
  const sessions: { environment: Environment; session: TiltSession; stops: number }[] = [];
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
      let running = true;
      const item = { environment, stops: 0, session: undefined as unknown as TiltSession };
      item.session = { get running() { return running; }, stop: async () => { item.stops++; running = false; } };
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

test('MVP close during awaited cluster setup prevents an orphan Tilt launch', async () => {
  let entered!: () => void, finish!: () => void, launches = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const setup = new Promise<void>(resolve => { finish = resolve; });
  const dev = new LocalDev({ run: async command => { if (command === 'k3d') return '[]'; entered(); await setup; return ''; }, startTilt: async () => { launches++; throw new Error('should not run'); } });
  const pending = dev.execute('wasm-platform', 'start');
  await ready;
  await dev.close();
  finish();
  await assert.rejects(pending, /closed during cluster setup/);
  assert.equal(launches, 0);
});

test('MVP rejects overlapping calls so one session handle cannot overwrite another', async () => {
  let entered!: () => void, finish!: () => void, launches = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const setup = new Promise<void>(resolve => { finish = resolve; });
  const dev = new LocalDev({
    run: async command => { if (command === 'k3d') return '[]'; entered(); await setup; return ''; },
    startTilt: async () => { launches++; return { running: true, stop: async () => {} }; },
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
