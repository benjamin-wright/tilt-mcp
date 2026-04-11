import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getResource, getResourceLogs, waitForBuild } from '../../tilt/client.js';
import type { BuildRecord } from '../../tilt/types.js';

const POLL_INTERVAL_MS = 1_000;
const WAIT_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = WAIT_TIMEOUT_MS + 5_000;

async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

test('always-succeeds: build completes without error', { timeout: TEST_TIMEOUT_MS }, async () => {
  await waitFor(async () => {
    const r = await getResource('always-succeeds');
    const history = r.status.buildHistory ?? [];
    return history.length > 0 && !!history[0].finishTime;
  }, 'always-succeeds to have a completed build record');

  const r = await getResource('always-succeeds');
  const latest = r.status.buildHistory?.[0] as BuildRecord | undefined;
  assert.ok(latest, 'should have at least one build record');
  assert.ok(!latest.error, `expected no build error, got: ${latest.error}`);
});

test('always-fails-build: most recent build record has an error', { timeout: TEST_TIMEOUT_MS }, async () => {
  await waitFor(async () => {
    const r = await getResource('always-fails-build');
    const history = r.status.buildHistory ?? [];
    return history.length > 0 && !!history[0].finishTime;
  }, 'always-fails-build to have a completed build record');

  const r = await getResource('always-fails-build');
  const latest = r.status.buildHistory?.[0] as BuildRecord | undefined;
  assert.ok(latest?.error, 'expected a build error but got none');
});

test('always-fails-runtime: runtime status is error', { timeout: TEST_TIMEOUT_MS }, async () => {
  await waitFor(async () => {
    const r = await getResource('always-fails-runtime');
    return r.status.runtimeStatus === 'error';
  }, 'always-fails-runtime to reach error runtime status');

  const r = await getResource('always-fails-runtime');
  assert.equal(r.status.runtimeStatus, 'error');
});

// --- getResourceLogs ---

test('getResourceLogs: build logs returned for always-fails-build', { timeout: TEST_TIMEOUT_MS }, async () => {
  await waitFor(async () => {
    const r = await getResource('always-fails-build');
    return (r.status.buildHistory ?? []).length > 0 && !!r.status.buildHistory![0].finishTime;
  }, 'always-fails-build to have a completed build record');

  const segments = await getResourceLogs('always-fails-build', 'build');
  const text = segments.map(s => s.text).join('');
  assert.ok(text.length > 0, 'expected non-empty build logs');
  assert.ok(text.includes('build failed'), `expected "build failed" in logs, got: ${text}`);
});

test('getResourceLogs: runtime logs empty for resource without serve_cmd', { timeout: TEST_TIMEOUT_MS }, async () => {
  await waitFor(async () => {
    const r = await getResource('always-fails-build');
    return (r.status.buildHistory ?? []).length > 0 && !!r.status.buildHistory![0].finishTime;
  }, 'always-fails-build to have a completed build record');

  const segments = await getResourceLogs('always-fails-build', 'runtime');
  assert.equal(segments.length, 0, 'expected no runtime log segments for a build-only resource');
});

test('getResourceLogs: all logs includes same content as build for build-only resource', { timeout: TEST_TIMEOUT_MS }, async () => {
  await waitFor(async () => {
    const r = await getResource('always-succeeds');
    return (r.status.buildHistory ?? []).length > 0 && !!r.status.buildHistory![0].finishTime;
  }, 'always-succeeds to have a completed build record');

  const buildSegments = await getResourceLogs('always-succeeds', 'build');
  const allSegments = await getResourceLogs('always-succeeds', 'all');
  const buildText = buildSegments.map(s => s.text).join('');
  const allText = allSegments.map(s => s.text).join('');
  assert.ok(buildText.includes('build ok'), `expected "build ok" in build logs, got: ${buildText}`);
  assert.equal(allText, buildText, 'all logs should equal build logs for a resource with no runtime');
});

// --- waitForBuild ---

test('waitForBuild: resolves once all resources have settled', { timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await waitForBuild(WAIT_TIMEOUT_MS / 1_000);
  assert.ok(result.elapsed >= 0, 'elapsed should be non-negative');
  assert.ok(result.resources.length > 0, 'expected at least one resource in result');
  const names = result.resources.map(r => r.name);
  assert.ok(names.includes('always-succeeds'), 'expected always-succeeds in result');
  assert.ok(names.includes('always-fails-build'), 'expected always-fails-build in result');
});

test('waitForBuild: correctly identifies errored and successful resources', { timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await waitForBuild(WAIT_TIMEOUT_MS / 1_000);

  const succeeds = result.resources.find(r => r.name === 'always-succeeds');
  assert.ok(succeeds, 'always-succeeds missing from result');
  assert.equal(succeeds!.updateStatus, 'ok', 'always-succeeds should have updateStatus=ok');
  assert.ok(!succeeds!.error, 'always-succeeds should have no error');

  const failsBuild = result.resources.find(r => r.name === 'always-fails-build');
  assert.ok(failsBuild, 'always-fails-build missing from result');
  assert.equal(failsBuild!.updateStatus, 'error', 'always-fails-build should have updateStatus=error');
  assert.ok(failsBuild!.error, 'always-fails-build should have an error message');
});
