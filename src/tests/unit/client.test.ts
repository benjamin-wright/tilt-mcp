import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { triggerResource, waitForBuild } from '../../tilt/client.js';
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
  return { uiResources: resources, uiSession: { metadata: { name: 'session' }, status: { tiltStartTime: start, fatalError } } };
}

function mockTilt(t: TestContext, snapshots: TiltView[], triggerBody = '') {
  let reads = 0;
  const triggers: unknown[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.ok(init?.signal, 'network requests must be bounded');
    if (url.endsWith('/api/view')) {
      const snapshot = snapshots[Math.min(reads++, snapshots.length - 1)];
      return Response.json(snapshot);
    }
    assert.ok(url.endsWith('/api/trigger'));
    assert.equal(init?.method, 'POST');
    triggers.push(JSON.parse(String(init?.body)));
    return new Response(triggerBody, { status: 200 });
  };
  t.mock.method(globalThis, 'fetch', fetchMock);
  return { reads: () => reads, triggers };
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
