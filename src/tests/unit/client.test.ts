import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cancelResource, getResourceLogs, triggerResource, waitForBuild } from '../../tilt/client.js';
import { tiltTransport } from '../../tilt/transport.js';
import type { TiltView, UIButton, UIResource, UIResourceStatus } from '../../tilt/types.js';

const OLD_BUILD = '2026-10-11T10:00:00Z';
const NEW_BUILD = '2026-10-11T10:00:01Z';
const SESSION_START = '2026-10-11T09:00:00Z';

function resource(name: string, status: Partial<UIResourceStatus> = {}): UIResource {
  return {
    metadata: { name },
    status: {
      updateStatus: 'ok',
      runtimeStatus: 'ok',
      buildHistory: [{ startTime: OLD_BUILD, finishTime: OLD_BUILD }],
      ...status,
    },
  };
}

function view(resources: UIResource[], fatalError?: string, start = SESSION_START): TiltView {
  return {
    uiResources: resources,
    uiButtons: resources.filter(resource => resource.status.currentBuild).map(resource => ({
      metadata: { name: `${resource.metadata.name}-stopbuild`, resourceVersion: '42', annotations: { 'tilt.dev/uibutton-type': 'StopBuild' } },
      spec: { location: { componentID: resource.metadata.name, componentType: 'Resource' } },
      status: {},
    })),
    uiSession: { metadata: { name: 'session' }, status: { tiltStartTime: start, fatalError } },
  };
}

function mockTilt(t: TestContext, snapshots: TiltView[], triggerError?: string) {
  let reads = 0;
  const triggers: string[] = [];
  const cancels: Array<{ button: UIButton; timestamp: string }> = [];
  t.mock.method(tiltTransport, 'snapshot', async (signal?: AbortSignal) => {
    return snapshots[Math.min(reads++, snapshots.length - 1)];
  });
  t.mock.method(tiltTransport, 'trigger', async (name: string, signal?: AbortSignal) => {
    if (triggerError) throw new Error(triggerError);
    triggers.push(name);
  });
  t.mock.method(tiltTransport, 'cancel', async (button: UIButton, timestamp: string, signal?: AbortSignal) => {
    cancels.push({ button, timestamp });
  });
  return { reads: () => reads, triggers, cancels };
}

test('wait checks every resource in a full snapshot before settling', async t => {
  const mock = mockTilt(t, [
    view([resource('one'), resource('two', { updateStatus: 'in_progress', currentBuild: { startTime: NEW_BUILD } })]),
    view([resource('one'), resource('two')]),
  ]);
  const result = await waitForBuild(2);
  assert.equal(mock.reads(), 2);
  assert.deepEqual(result.resources.map(r => r.name), ['one', 'two']);
});

test('wait includes deployment readiness after the build has finished', async t => {
  const mock = mockTilt(t, [
    view([resource('deployment', { runtimeStatus: 'pending' })]),
    view([resource('deployment')]),
  ]);
  const result = await waitForBuild(2);
  assert.equal(mock.reads(), 2);
  assert.equal(result.resources[0].runtimeStatus, 'ok');
});

test('queued work cannot return an earlier successful status', async t => {
  const mock = mockTilt(t, [view([resource('queued', { queued: true })]), view([resource('queued')])]);
  await waitForBuild(2);
  assert.equal(mock.reads(), 2);
});

test('wait rejects fatal session and Tiltfile build failures', async t => {
  mockTilt(t, [view([resource('one')], 'bad Tiltfile syntax')]);
  await assert.rejects(waitForBuild(2), /Tilt session failed: bad Tiltfile syntax/);
});

test('wait checks Tiltfile errors even when selected resources are ready', async t => {
  mockTilt(t, [view([
    resource('one'),
    resource('(Tiltfile)', { updateStatus: 'error', buildHistory: [{ startTime: OLD_BUILD, finishTime: OLD_BUILD, error: 'extension failed' }] }),
  ])]);
  await assert.rejects(waitForBuild(2, ['one']), /Tiltfile failed: extension failed/);
});

test('wait reports terminal build and runtime failures without calling them ready', async t => {
  mockTilt(t, [view([
    resource('build', { updateStatus: 'error', runtimeStatus: 'pending', buildHistory: [{ startTime: OLD_BUILD, finishTime: OLD_BUILD, error: 'test failed' }] }),
    resource('runtime', { runtimeStatus: 'error' }),
  ])]);
  const result = await waitForBuild(2);
  assert.equal(result.resources[0].error, 'test failed');
  assert.match(result.resources[1].error!, /Runtime failed/);
});

test('resource selection allows a test to finish while unrelated work is pending', async t => {
  mockTilt(t, [view([resource('test', { runtimeStatus: 'not_applicable' }), resource('unrelated', { updateStatus: 'pending' })])]);
  const result = await waitForBuild(2, ['test']);
  assert.deepEqual(result.resources.map(r => r.name), ['test']);
});

test('manual resources that have never run are identified as skipped', async t => {
  mockTilt(t, [view([resource('manual-test', { updateStatus: 'none', runtimeStatus: 'not_applicable', buildHistory: [] })])]);
  const result = await waitForBuild(2);
  assert.equal(result.resources[0].skipped, true);
});

test('trigger followed by wait requires a new completion despite delayed scheduling', async t => {
  const name = 'delayed-trigger';
  const mock = mockTilt(t, [
    view([resource(name)]), // baseline before triggering
    view([resource(name)]), // queue has not become visible yet
    view([resource(name, { buildHistory: [{ startTime: NEW_BUILD, finishTime: NEW_BUILD }] })]),
  ]);
  await triggerResource(name);
  const result = await waitForBuild(2, [name]);
  assert.equal(mock.reads(), 3);
  assert.equal(result.resources[0].error, undefined);
  assert.deepEqual(mock.triggers, [name]);
});

test('a build already in progress before trigger is not mistaken for the triggered build', async t => {
  const name = 'already-building';
  const newest = '2026-10-11T10:00:02Z';
  const mock = mockTilt(t, [
    view([resource(name, { currentBuild: { startTime: NEW_BUILD } })]),
    view([resource(name, { buildHistory: [{ startTime: NEW_BUILD, finishTime: NEW_BUILD }] })]),
    view([resource(name, { buildHistory: [{ startTime: newest, finishTime: newest }] })]),
  ]);
  await triggerResource(name);
  await waitForBuild(2, [name]);
  assert.equal(mock.reads(), 3);
});

test('trigger propagates transport failures', async t => {
  mockTilt(t, [view([resource('disabled')])], 'resource "disabled" is currently disabled');
  await assert.rejects(triggerResource('disabled'), /currently disabled/);
});

test('wait rejects session switches after a trigger rather than reusing another environment', async t => {
  const name = 'switched-session';
  mockTilt(t, [view([resource(name)]), view([resource(name)], undefined, 'different-session')]);
  await triggerResource(name);
  await assert.rejects(waitForBuild(2, [name]), /Tilt session changed/);
});

test('runtime readiness waits are bounded and name the pending resource', async t => {
  mockTilt(t, [view([resource('pending-deployment', { runtimeStatus: 'pending' })])]);
  await assert.rejects(waitForBuild(0.02), /Timed out.*pending-deployment/);
});

test('wait reports nonexistent selections and rejects invalid timeout bounds', async t => {
  mockTilt(t, [view([resource('one')])]);
  await assert.rejects(waitForBuild(2, ['missing']), /Resources not found: missing/);
  await assert.rejects(waitForBuild(0), /timeoutSeconds/);
  await assert.rejects(waitForBuild(3601), /timeoutSeconds/);
  await assert.rejects(waitForBuild(2, []), /names/);
});

test('wait forwards cancellation to an in-flight snapshot request', async t => {
  const controller = new AbortController();
  t.mock.method(tiltTransport, 'snapshot', async (signal?: AbortSignal) => {
    assert.ok(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const waiting = waitForBuild(2, undefined, controller.signal);
  controller.abort(new Error('client cancelled'));
  await assert.rejects(waiting, /client cancelled/);
});

test('cancel passes only the generated Stop Build button and observed microsecond start time', async t => {
  const name = 'execution-host: regression-tests';
  const startTime = '2026-10-13T17:30:00.123456Z';
  const snapshot = view([resource(name, { updateStatus: 'in_progress', currentBuild: { startTime } }), resource('unrelated')]);
  const mock = mockTilt(t, [snapshot]);
  assert.deepEqual(await cancelResource(name), { name, status: 'cancel_requested' });
  assert.equal(mock.cancels.length, 1);
  assert.deepEqual(mock.cancels[0], { button: snapshot.uiButtons![0], timestamp: startTime });
  assert.deepEqual(mock.triggers, []);
});

test('cancel is a no-op for idle builds and rejects missing or queued-only resources', async t => {
  const mock = mockTilt(t, [view([resource('idle'), resource('queued-only', { queued: true })])]);
  assert.deepEqual(await cancelResource('idle'), { name: 'idle', status: 'not_building' });
  await assert.rejects(cancelResource('missing'), /Resource not found/);
  await assert.rejects(cancelResource('queued-only'), /no active build.*queued builds/);
  assert.equal(mock.cancels.length, 0);
});

test('cancel refuses missing, custom, mismatched or ambiguous buttons before any mutation', async t => {
  const name = 'safe-task';
  for (const change of [
    (snapshot: TiltView) => { snapshot.uiButtons = []; },
    (snapshot: TiltView) => { snapshot.uiButtons![0].metadata.annotations!['tilt.dev/uibutton-type'] = 'Custom'; },
    (snapshot: TiltView) => { snapshot.uiButtons![0].spec.location!.componentID = 'another-resource'; },
    (snapshot: TiltView) => { snapshot.uiButtons!.push(snapshot.uiButtons![0]); },
  ]) {
    const snapshot = view([resource(name, { currentBuild: { startTime: NEW_BUILD } })]);
    change(snapshot);
    const mock = mockTilt(t, [snapshot]);
    await assert.rejects(cancelResource(name), /generated Stop Build button is unavailable/);
    assert.equal(mock.cancels.length, 0);
  }
});

test('cancel normalizes seconds to six timestamp digits and rejects malformed timestamps', async t => {
  const good = 'normalized-cancel';
  const mock = mockTilt(t, [view([resource(good, { currentBuild: { startTime: NEW_BUILD } })])]);
  await cancelResource(good);
  assert.equal(mock.cancels[0].timestamp, NEW_BUILD.replace('Z', '.000000Z'));
  const invalid = mockTilt(t, [view([resource('bad-time', { currentBuild: { startTime: 'invalid' } })])]);
  await assert.rejects(cancelResource('bad-time'), /invalid current build start time/);
  assert.equal(invalid.cancels.length, 0);
});

test('cancel retains freshness for the next build already requested behind an active build', async t => {
  const name = 'cancel-then-queued-trigger';
  const next = '2026-10-11T10:00:02Z';
  const mock = mockTilt(t, [
    view([resource(name, { currentBuild: { startTime: NEW_BUILD } })]),
    view([resource(name, { currentBuild: { startTime: NEW_BUILD }, queued: true })]),
    view([resource(name, { buildHistory: [{ startTime: NEW_BUILD, finishTime: NEW_BUILD }] })]),
    view([resource(name, { buildHistory: [{ startTime: next, finishTime: next }] })]),
  ]);
  await triggerResource(name);
  await cancelResource(name);
  await waitForBuild(2, [name]);
  assert.equal(mock.reads(), 4);
});

test('a cancelled build reports its result and can be triggered again with a fresh completion', async t => {
  const name = 'cancel-and-rerun';
  const next = '2026-10-11T10:00:02Z';
  const cancelled = resource(name, { updateStatus: 'error', runtimeStatus: 'not_applicable', buildHistory: [{ startTime: NEW_BUILD, finishTime: NEW_BUILD, error: 'build canceled' }] });
  const mock = mockTilt(t, [
    view([resource(name)]),
    view([resource(name, { currentBuild: { startTime: NEW_BUILD } })]),
    view([cancelled]),
    view([cancelled]),
    view([cancelled]),
    view([resource(name, { buildHistory: [{ startTime: next, finishTime: next }] })]),
  ]);
  await triggerResource(name);
  await cancelResource(name);
  const failed = await waitForBuild(2, [name]);
  assert.equal(failed.resources[0].error, 'build canceled');
  await triggerResource(name);
  const rerun = await waitForBuild(2, [name]);
  assert.equal(rerun.resources[0].error, undefined);
  assert.equal(mock.reads(), 6);
});

test('a concurrent newer trigger survives an older cancellation acknowledgement', async t => {
  const name = 'cancel-concurrent-trigger';
  const next = '2026-10-11T10:00:02Z';
  const mock = mockTilt(t, [
    view([resource(name)]),
    view([resource(name, { currentBuild: { startTime: NEW_BUILD } })]),
    view([resource(name, { currentBuild: { startTime: NEW_BUILD } })]),
    view([resource(name, { buildHistory: [{ startTime: NEW_BUILD, finishTime: NEW_BUILD }] })]),
    view([resource(name, { buildHistory: [{ startTime: next, finishTime: next }] })]),
  ]);
  const existingCancel = tiltTransport.cancel;
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const completed = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(tiltTransport, 'cancel', async (button: UIButton, timestamp: string, signal?: AbortSignal) => {
    enter();
    await completed;
    return existingCancel(button, timestamp, signal);
  });
  await triggerResource(name);
  const cancellation = cancelResource(name);
  await entered;
  await triggerResource(name);
  finish();
  await cancellation;
  await waitForBuild(2, [name]);
  assert.equal(mock.reads(), 5);
});

test('cancel errors and invalid resource names do not invoke another mutation', async t => {
  let writes = 0;
  mockTilt(t, [view([resource('conflict-task', { currentBuild: { startTime: NEW_BUILD } })])]);
  t.mock.method(tiltTransport, 'cancel', async () => {
    writes++;
    throw new Error('conflict');
  });
  await assert.rejects(cancelResource('conflict-task'), /conflict/);
  assert.equal(writes, 1);
  for (const name of ['', ' ', 'x'.repeat(254), 'x\n']) {
    await assert.rejects(cancelResource(name), /resource name/);
    await assert.rejects(triggerResource(name), /resource name/);
  }
  assert.equal(writes, 1);
});

test('request cancellation reaches both trigger and cancel transport operations', async t => {
  for (const [operation, method] of [[triggerResource, 'trigger'], [cancelResource, 'cancel']] as const) {
    const controller = new AbortController();
    mockTilt(t, [view([resource('abort-build-action', { currentBuild: { startTime: NEW_BUILD } })])]);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const block = (signal?: AbortSignal) => {
      assert.ok(signal);
      entered();
      return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    if (method === 'trigger') {
      t.mock.method(tiltTransport, 'trigger', (_name: string, signal?: AbortSignal) => block(signal));
    } else {
      t.mock.method(tiltTransport, 'cancel', (_button: UIButton, _timestamp: string, signal?: AbortSignal) => block(signal));
    }
    const pending = operation('abort-build-action', controller.signal);
    await started;
    controller.abort(new Error('stop request'));
    await assert.rejects(pending, /stop request/);
  }
});

test('logs pass each requested source to the transport and preserve returned segments', async t => {
  const calls: Array<[string, string]> = [];
  const segments = [{ text: 'test output', level: 'INFO' }];
  t.mock.method(tiltTransport, 'logs', async (name: string, source: string) => {
    calls.push([name, source]);
    return segments;
  });
  for (const source of ['all', 'build', 'runtime'] as const) {
    assert.equal(await getResourceLogs('test-task', source), segments);
  }
  assert.deepEqual(calls, [['test-task', 'all'], ['test-task', 'build'], ['test-task', 'runtime']]);
  await assert.rejects(getResourceLogs(''), /resource name/);
  assert.equal(calls.length, 3);
});

test('logs propagate transport errors', async t => {
  t.mock.method(tiltTransport, 'logs', async () => { throw new Error('logs unavailable'); });
  await assert.rejects(getResourceLogs('test-task'), /logs unavailable/);
});
