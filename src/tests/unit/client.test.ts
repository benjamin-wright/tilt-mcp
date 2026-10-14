import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cancelResource, triggerResource, waitForBuild } from '../../tilt/client.js';
import type { TiltView, UIResource, UIResourceStatus } from '../../tilt/types.js';

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

function mockTilt(t: TestContext, snapshots: TiltView[], triggerBody = '') {
  let reads = 0;
  const triggers: unknown[] = [];
  const cancels: Array<{ url: string; body: unknown }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.ok(init?.signal, 'network requests must be bounded');
    if (url.endsWith('/api/view')) {
      const snapshot = snapshots[Math.min(reads++, snapshots.length - 1)];
      return Response.json(snapshot);
    }
    if (url.includes('/proxy/apis/tilt.dev/v1alpha1/uibuttons/') && url.endsWith('/status')) {
      assert.equal(init?.method, 'PUT');
      assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json');
      cancels.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({});
    }
    assert.ok(url.endsWith('/api/trigger'));
    assert.equal(init?.method, 'POST');
    triggers.push(JSON.parse(String(init?.body)));
    return new Response(triggerBody, { status: 200 });
  };
  t.mock.method(globalThis, 'fetch', fetchMock);
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
    view([resource(name)]), // baseline before POST
    view([resource(name)]), // queue has not become visible yet
    view([resource(name, { buildHistory: [{ startTime: NEW_BUILD, finishTime: NEW_BUILD }] })]),
  ]);
  await triggerResource(name);
  const result = await waitForBuild(2, [name]);
  assert.equal(mock.reads(), 3);
  assert.equal(result.resources[0].error, undefined);
  assert.deepEqual(mock.triggers, [{ manifest_names: [name], build_reason: 32 }]);
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

test('trigger treats an HTTP 200 error body as a failure', async t => {
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

test('wait forwards cancellation to an in-flight network request', async t => {
  const controller = new AbortController();
  const fetchMock: typeof fetch = async (_input, init) => {
    assert.ok(init?.signal);
    return new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  };
  t.mock.method(globalThis, 'fetch', fetchMock);
  const waiting = waitForBuild(2, undefined, controller.signal);
  controller.abort(new Error('client cancelled'));
  await assert.rejects(waiting, /client cancelled/);
});

test('cancel uses only the generated Stop Build status endpoint and observed microsecond start time', async t => {
  const name = 'execution-host: regression-tests';
  const startTime = '2026-10-13T17:30:00.123456Z';
  const snapshot = view([resource(name, { updateStatus: 'in_progress', currentBuild: { startTime } }), resource('unrelated')]);
  const mock = mockTilt(t, [snapshot]);
  assert.deepEqual(await cancelResource(name), { name, status: 'cancel_requested' });
  assert.equal(mock.cancels.length, 1);
  assert.ok(mock.cancels[0].url.endsWith('/uibuttons/execution-host%3A%20regression-tests-stopbuild/status'));
  assert.deepEqual(mock.cancels[0].body, { metadata: snapshot.uiButtons![0].metadata, status: { lastClickedAt: startTime } });
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
  assert.equal((mock.cancels[0].body as { status: { lastClickedAt: string } }).status.lastClickedAt, NEW_BUILD.replace('Z', '.000000Z'));
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
  const existingFetch = globalThis.fetch;
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const completed = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === 'PUT') { enter(); await completed; }
    return existingFetch(input, init);
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
  t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === 'PUT') { writes++; return new Response('conflict', { status: 409 }); }
    return Response.json(view([resource('conflict-task', { currentBuild: { startTime: NEW_BUILD } })]));
  });
  await assert.rejects(cancelResource('conflict-task'), /HTTP 409/);
  assert.equal(writes, 1);
  for (const name of ['', ' ', 'x'.repeat(254), 'x\n']) {
    await assert.rejects(cancelResource(name), /resource name/);
    await assert.rejects(triggerResource(name), /resource name/);
  }
  assert.equal(writes, 1);
});

test('request cancellation reaches both trigger and cancel HTTP operations', async t => {
  for (const operation of [triggerResource, cancelResource]) {
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.ok(init?.signal);
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    });
    const pending = operation('abort-build-action', controller.signal);
    controller.abort(new Error('stop request'));
    await assert.rejects(pending, /stop request/);
  }
});
