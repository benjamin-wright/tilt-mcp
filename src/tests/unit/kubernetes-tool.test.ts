import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../server.js';
import type { KubernetesClient } from '../../kubernetes/client.js';
import { MAX_PAGE_LIMIT, type ApiResourceDiscovery, type KubernetesMetadataList } from '../../kubernetes/types.js';

test('Kubernetes MCP tools expose constrained read operations', async t => {
  const discovery: ApiResourceDiscovery = {
    environment: 'db-operator',
    resources: [
      { group: '', version: 'v1', kind: 'Pod', name: 'pods', namespaced: true, verbs: ['get', 'list'] },
      { group: 'example.com', version: 'v1', kind: 'Widget', name: 'widgets', namespaced: true, verbs: ['get', 'list'] },
    ],
    errors: [{ group: 'unavailable.example.com', version: 'v1', error: 'API unavailable' }],
  };
  const metadataList: KubernetesMetadataList = {
    environment: 'db-operator', group: 'example.com', version: 'v1', kind: 'Widget', resource: 'widgets',
    metadata: { continue: 'next-page', resourceVersion: '123' },
    items: [{ apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name: 'database', namespace: 'default', uid: 'widget-1' } }],
  };
  const fullResource = {
    apiVersion: 'v1', kind: 'Pod', metadata: { name: 'worker', namespace: 'default', uid: 'pod-1' },
    spec: { containers: [{ name: 'worker', image: 'worker:latest' }] },
    status: { phase: 'Running' },
  };
  const calls: Array<[string, unknown]> = [];
  let failure: Error | undefined;
  const kubernetes: Pick<KubernetesClient, 'listApiResources' | 'listResources' | 'getResource'> = {
    async listApiResources(environment) { calls.push(['discovery', environment]); if (failure) throw failure; return discovery; },
    async listResources(options) { calls.push(['list', options]); if (failure) throw failure; return metadataList; },
    async getResource(options) { calls.push(['get', options]); if (failure) throw failure; return fullResource; },
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ kubernetes });
  const client = new Client({ name: 'kubernetes-tool-test', version: '0.1.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });

  await t.test('tools advertise read-only annotations and strict environment/GVK inputs', async () => {
    const { tools } = await client.listTools();
    for (const [name, properties, required] of [
      ['list_kubernetes_api_resources', ['environment'], ['environment']],
      ['list_kubernetes_resources', ['environment', 'group', 'version', 'kind', 'namespace', 'limit', 'continue'], ['environment', 'group', 'version', 'kind']],
      ['get_kubernetes_resource', ['environment', 'group', 'version', 'kind', 'namespace', 'name'], ['environment', 'group', 'version', 'kind', 'name']],
    ] as const) {
      const tool = tools.find(tool => tool.name === name);
      assert.ok(tool);
      assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      const schema = tool.inputSchema as unknown as {
        properties: Record<string, { enum?: string[] }>;
        required: string[];
        additionalProperties: boolean;
      };
      assert.deepEqual(Object.keys(schema.properties), properties);
      assert.deepEqual(schema.properties.environment.enum, ['wasm-platform', 'db-operator']);
      assert.deepEqual(schema.required, required);
      assert.equal(schema.additionalProperties, false);
    }
  });

  await t.test('discovery forwards the environment and returns resources plus partial failures', async () => {
    const result = await client.callTool({ name: 'list_kubernetes_api_resources', arguments: { environment: 'db-operator' } });
    assert.deepEqual(calls.at(-1), ['discovery', 'db-operator']);
    assert.deepEqual(result.structuredContent, discovery);
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(discovery) }]);
  });

  await t.test('list forwards GVK, namespace and pagination and returns metadata only', async () => {
    const options = { environment: 'db-operator', group: 'example.com', version: 'v1', kind: 'Widget', namespace: 'default', limit: 25, continue: 'previous-page' };
    const result = await client.callTool({ name: 'list_kubernetes_resources', arguments: options });
    assert.deepEqual(calls.at(-1), ['list', options]);
    assert.deepEqual(result.structuredContent, metadataList);
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(metadataList) }]);
    assert.deepEqual(Object.keys((result.structuredContent as unknown as KubernetesMetadataList).items[0]), ['apiVersion', 'kind', 'metadata']);

    const allNamespaces = { environment: 'wasm-platform', group: '', version: 'v1', kind: 'Pod' };
    await client.callTool({ name: 'list_kubernetes_resources', arguments: allNamespaces });
    assert.deepEqual(calls.at(-1), ['list', allNamespaces]);
  });

  await t.test('get forwards the resource identity and returns full details', async () => {
    const options = { environment: 'wasm-platform', group: '', version: 'v1', kind: 'Pod', namespace: 'default', name: 'worker' };
    const result = await client.callTool({ name: 'get_kubernetes_resource', arguments: options });
    assert.deepEqual(calls.at(-1), ['get', options]);
    assert.deepEqual(result.structuredContent, fullResource);
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(fullResource) }]);

    const clusterScoped = { environment: 'db-operator', group: '', version: 'v1', kind: 'Node', name: 'k3d-server-0' };
    await client.callTool({ name: 'get_kubernetes_resource', arguments: clusterScoped });
    assert.deepEqual(calls.at(-1), ['get', clusterScoped]);
  });

  await t.test('invalid inputs and arbitrary commands, flags, paths or URLs never reach the client', async () => {
    const validSelection = { environment: 'wasm-platform', group: '', version: 'v1', kind: 'Pod' };
    const validRequests = [
      { name: 'list_kubernetes_api_resources', arguments: { environment: 'wasm-platform' } },
      { name: 'list_kubernetes_resources', arguments: validSelection },
      { name: 'get_kubernetes_resource', arguments: { ...validSelection, name: 'worker', namespace: 'default' } },
    ];
    const forbiddenFields: Record<string, unknown> = {
      command: 'kubectl delete pods', args: ['delete', 'pods'], flags: ['--server=http://example.com'],
      path: '/etc/passwd', url: 'http://example.com', kubeconfig: '/tmp/config', context: 'production', method: 'POST',
    };
    const requests: Array<{ name: string; arguments: Record<string, unknown> }> = validRequests.flatMap(request =>
      Object.entries(forbiddenFields).map(([key, value]) => ({ name: request.name, arguments: { ...request.arguments, [key]: value } }))
    );
    requests.push(
      { name: 'list_kubernetes_api_resources', arguments: {} },
      { name: 'list_kubernetes_api_resources', arguments: { environment: 'production' } },
      ...[
        { ...validSelection, group: '../api' },
        { ...validSelection, version: 'v1/../secrets' },
        { ...validSelection, kind: 'Pod/status' },
        { ...validSelection, namespace: '../default' },
        { ...validSelection, limit: 0 },
        { ...validSelection, limit: MAX_PAGE_LIMIT + 1 },
        { ...validSelection, limit: 1.5 },
        { ...validSelection, continue: '' },
        { environment: 'wasm-platform', group: '', kind: 'Pod' },
      ].map(arguments_ => ({ name: 'list_kubernetes_resources', arguments: arguments_ })),
      { name: 'get_kubernetes_resource', arguments: validSelection },
      { name: 'get_kubernetes_resource', arguments: { ...validSelection, name: '../config' } },
      { name: 'get_kubernetes_resource', arguments: { ...validSelection, name: '.' } },
    );
    const previousCalls = calls.length;
    for (const request of requests) {
      const result = await client.callTool(request);
      assert.equal(result.isError, true, JSON.stringify(request));
    }
    assert.equal(calls.length, previousCalls);
  });

  await t.test('client failures become MCP tool errors', async () => {
    failure = new Error('Kubernetes API is unavailable');
    for (const request of [
      { name: 'list_kubernetes_api_resources', arguments: { environment: 'wasm-platform' } },
      { name: 'list_kubernetes_resources', arguments: { environment: 'wasm-platform', group: '', version: 'v1', kind: 'Pod' } },
      { name: 'get_kubernetes_resource', arguments: { environment: 'wasm-platform', group: '', version: 'v1', kind: 'Pod', name: 'worker', namespace: 'default' } },
    ]) {
      const result = await client.callTool(request);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /Kubernetes API is unavailable/);
    }
    failure = undefined;
  });
});
