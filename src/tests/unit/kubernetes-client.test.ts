import test from 'node:test';
import assert from 'node:assert/strict';
import { KubernetesClient } from '../../kubernetes/client.js';
import type { KubernetesRequest } from '../../kubernetes/connection.js';
import type { GetResourceOptions, ListResourceOptions } from '../../kubernetes/types.js';

const pod = { name: 'pods', kind: 'Pod', namespaced: true, verbs: ['get', 'list', 'create'] };
const node = { name: 'nodes', kind: 'Node', namespaced: false, verbs: ['get', 'list'] };
const deployment = { name: 'deployments', kind: 'Deployment', namespaced: true, verbs: ['get', 'list'] };
const base = { environment: 'wasm-platform' as const, group: '', version: 'v1', kind: 'Pod' };

function fixture(responses: Record<string, unknown | Error>) {
  const calls: Array<{ environment: string; path: string; accept?: string }> = [];
  const request: KubernetesRequest = async (environment, path, options) => {
    calls.push({ environment, path, accept: options?.accept });
    assert.ok(options?.signal);
    const response = responses[path];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`Unexpected Kubernetes request: ${path}`);
    return response;
  };
  return { calls, client: new KubernetesClient({ request }) };
}

test('discovery includes all served group versions and excludes subresources', async () => {
  const fake = fixture({
    '/api': { versions: ['v1'] },
    '/apis': { groups: [{ name: 'apps', versions: [{ version: 'v1' }] }, { name: 'example.dev', versions: [{ version: 'v1' }, { version: 'v1beta1' }] }] },
    '/api/v1': { resources: [pod, node, { ...pod, name: 'pods/exec' }] },
    '/apis/apps/v1': { resources: [deployment] },
    '/apis/example.dev/v1': { resources: [{ name: 'widgets', kind: 'Widget', namespaced: true, verbs: ['get', 'list'] }] },
    '/apis/example.dev/v1beta1': { resources: [{ name: 'widgets', kind: 'Widget', namespaced: true, verbs: ['get', 'list'] }] },
  });
  const result = await fake.client.listApiResources('db-operator');
  assert.equal(result.environment, 'db-operator');
  assert.equal(result.resources.length, 5);
  assert.equal(result.resources.filter(resource => resource.kind === 'Widget').length, 2);
  assert.ok(result.resources.every(resource => !resource.name.includes('/')));
  assert.ok(result.resources.some(resource => resource.kind === 'Node' && !resource.namespaced));
  assert.deepEqual(result.errors, []);
  assert.ok(fake.calls.every(call => call.environment === 'db-operator'));
});

test('discovery reports unavailable API versions while retaining successful discovery', async () => {
  const fake = fixture({ '/api': { versions: ['v1'] }, '/apis': { groups: [{ name: 'metrics.k8s.io', versions: [{ version: 'v1beta1' }] }] }, '/api/v1': { resources: [pod] }, '/apis/metrics.k8s.io/v1beta1': new Error('Kubernetes API returned HTTP 503') });
  const result = await fake.client.listApiResources('wasm-platform');
  assert.equal(result.resources.length, 1);
  assert.deepEqual(result.errors, [{ group: 'metrics.k8s.io', version: 'v1beta1', error: 'Kubernetes API returned HTTP 503' }]);
});

test('hyphenated custom API kinds and versions remain discoverable and listable', async () => {
  const custom = { name: 'foo-bars', kind: 'Foo-Bar', namespaced: false, verbs: ['get', 'list'] };
  const fake = fixture({
    '/api': { versions: ['v1'] }, '/api/v1': { resources: [] },
    '/apis': { groups: [{ name: 'example.dev', versions: [{ version: 'v1-preview' }] }] },
    '/apis/example.dev/v1-preview': { resources: [custom] },
    '/apis/example.dev/v1-preview/foo-bars?limit=100': { metadata: {}, items: [{ metadata: { name: 'one' } }] },
  });
  const discovered = await fake.client.listApiResources('wasm-platform');
  assert.equal(discovered.resources[0].kind, 'Foo-Bar');
  assert.deepEqual(discovered.errors, []);
  const result = await fake.client.listResources({ ...base, group: 'example.dev', version: 'v1-preview', kind: 'Foo-Bar' });
  assert.deepEqual(result.items, [{ apiVersion: 'example.dev/v1-preview', kind: 'Foo-Bar', metadata: { name: 'one' } }]);
});

test('metadata list requests metadata-only and strips full objects returned by fallback servers', async () => {
  const metadata = { name: 'one', namespace: 'default', uid: 'uid', labels: { app: 'demo' } };
  const fake = fixture({ '/api/v1': { resources: [pod] }, '/api/v1/pods?limit=100': { metadata: { resourceVersion: '12', continue: 'next-page' }, items: [{ metadata, spec: { containers: [] }, status: { phase: 'Running' }, data: { password: 'must not appear' } }] } });
  const result = await fake.client.listResources(base);
  assert.deepEqual(result.items, [{ apiVersion: 'v1', kind: 'Pod', metadata }]);
  assert.deepEqual(result.metadata, { resourceVersion: '12', continue: 'next-page' });
  assert.equal(result.resource, 'pods');
  assert.ok(!JSON.stringify(result).includes('must not appear'));
  assert.match(fake.calls[1].accept!, /as=PartialObjectMetadataList/);
});

test('grouped namespace list safely carries bounded pagination tokens', async () => {
  const token = 'opaque+/=?&limit=999999';
  const query = new URLSearchParams({ limit: '5', continue: token });
  const path = `/apis/apps/v1/namespaces/demo/deployments?${query}`;
  const fake = fixture({ '/apis/apps/v1': { resources: [deployment] }, [path]: { metadata: { continue: 'next' }, items: [] } });
  const result = await fake.client.listResources({ ...base, group: 'apps', kind: 'Deployment', namespace: 'demo', limit: 5, continue: token });
  assert.deepEqual(result.items, []);
  assert.equal(result.metadata.continue, 'next');
  assert.equal(fake.calls[1].path, path);
});

test('single-resource get returns full detail using its discovered endpoint', async () => {
  const full = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'demo', namespace: 'demo' }, spec: { replicas: 2 }, status: { readyReplicas: 1 } };
  const fake = fixture({ '/apis/apps/v1': { resources: [deployment] }, '/apis/apps/v1/namespaces/demo/deployments/demo': full });
  const result = await fake.client.getResource({ ...base, group: 'apps', kind: 'Deployment', namespace: 'demo', name: 'demo' });
  assert.deepEqual(result, full);
  assert.equal(fake.calls[1].accept, undefined);
});

test('cluster-scoped resources omit namespace and names containing colons are encoded safely', async () => {
  const role = { name: 'clusterroles', kind: 'ClusterRole', namespaced: false, verbs: ['get', 'list'] };
  const full = { metadata: { name: 'system:admin' }, rules: [{ verbs: ['*'] }] };
  const fake = fixture({ '/apis/rbac.authorization.k8s.io/v1': { resources: [role] }, '/apis/rbac.authorization.k8s.io/v1/clusterroles/system%3Aadmin': full });
  assert.deepEqual(await fake.client.getResource({ ...base, group: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'system:admin' }), full);
});

test('namespace and kind errors never request a collection or object', async () => {
  for (const selection of [
    { ...base, name: 'one' },
    { ...base, kind: 'Node', namespace: 'demo', name: 'one' },
    { ...base, kind: 'Unknown', name: 'one' },
  ]) {
    const fake = fixture({ '/api/v1': { resources: [pod, node] } });
    await assert.rejects(fake.client.getResource(selection), /namespace|cluster-scoped|found 0/);
    assert.equal(fake.calls.length, 1);
  }
  const fake = fixture({ '/api/v1': { resources: [{ ...pod, verbs: ['create'] }] } });
  await assert.rejects(fake.client.listResources(base), /does not support list/);
  assert.equal(fake.calls.length, 1);
});

test('ambiguous kinds and discovered subresource paths are rejected', async () => {
  const fake = fixture({ '/api/v1': { resources: [pod, { ...pod, name: 'otherpods' }] } });
  await assert.rejects(fake.client.listResources(base), /found 2/);
  const subresource = fixture({ '/api/v1': { resources: [{ ...pod, name: 'pods/proxy' }] } });
  await assert.rejects(subresource.client.getResource({ ...base, name: 'one', namespace: 'default' }), /found 0/);
});

test('invalid resource selections fail before any external access', async () => {
  const fake = fixture({});
  for (const input of [
    { ...base, environment: 'production' }, { ...base, group: '../apps' },
    { ...base, version: 'v1/pods' }, { ...base, kind: 'Pod/exec' },
    { ...base, namespace: '../default' }, { ...base, url: 'https://example.com' },
    { ...base, limit: 501 }, { ...base, continue: 'x'.repeat(8193) },
  ]) await assert.rejects(fake.client.listResources(input as ListResourceOptions));
  for (const name of ['..', '.', '../one', 'one/exec', 'one%2Fproxy', 'one?watch=true']) {
    await assert.rejects(fake.client.getResource({ ...base, name, namespace: 'default' } as GetResourceOptions));
  }
  assert.equal(fake.calls.length, 0);
});

test('unbounded pages and malformed list responses fail explicitly', async () => {
  const fake = fixture({ '/api/v1': { resources: [pod] }, '/api/v1/pods?limit=1': { items: [{ metadata: {} }, { metadata: {} }] } });
  await assert.rejects(fake.client.listResources({ ...base, limit: 1 }), /page limit/);
  const malformed = fixture({ '/api/v1': { resources: [pod] }, '/api/v1/pods?limit=100': { items: [{ spec: {} }] } });
  await assert.rejects(malformed.client.listResources(base), /Invalid Kubernetes API response/);
});
