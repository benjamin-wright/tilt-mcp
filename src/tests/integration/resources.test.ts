import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getResource } from '../../tilt/client.js';
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
