import { requestKubernetes, type KubernetesRequest } from './connection.js';
import {
  DEFAULT_PAGE_LIMIT, METADATA_LIST_ACCEPT, discoveryInput, resourceTypeInput, listResourceInput, getResourceInput,
  type ApiResource, type ApiResourceDiscovery, type ResourceTypeSelection,
  type ListResourceOptions, type GetResourceOptions, type KubernetesMetadataList,
} from './types.js';
import type { Environment } from '../local-dev.js';

const MAX_DISCOVERY_VERSIONS = 256;
const MAX_DISCOVERY_RESOURCES = 10_000;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Kubernetes API response');
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid Kubernetes API response');
  return value;
}

function versionPath(group: string, version: string): string {
  return group ? `/apis/${group}/${version}` : `/api/${version}`;
}

function apiVersion(group: string, version: string): string {
  return group ? `${group}/${version}` : version;
}

/** Discovery resolves kinds to collection names; only read-only object endpoints are exposed. */
export class KubernetesClient {
  private readonly request: KubernetesRequest;

  constructor({ request = requestKubernetes }: { request?: KubernetesRequest } = {}) {
    this.request = request;
  }

  private async resources(environment: Environment, group: string, version: string, signal: AbortSignal): Promise<ApiResource[]> {
    const response = object(await this.request(environment, versionPath(group, version), { signal }));
    return array(response.resources).flatMap(raw => {
      const resource = object(raw);
      if (typeof resource.name !== 'string') throw new Error('Invalid Kubernetes discovery resource');
      if (resource.name.includes('/')) return [];
      if (!/^[a-z][a-z0-9-]{0,252}$/.test(resource.name) || typeof resource.namespaced !== 'boolean') throw new Error('Invalid Kubernetes discovery resource');
      const selected = resourceTypeInput.parse({ environment, group, version, kind: resource.kind });
      const verbs = array(resource.verbs);
      if (verbs.length > 32 || verbs.some(verb => typeof verb !== 'string' || !/^[a-z]{1,32}$/.test(verb))) throw new Error('Invalid Kubernetes discovery verbs');
      return [{ group, version, kind: selected.kind, name: resource.name, namespaced: resource.namespaced, verbs: verbs as string[] }];
    });
  }

  async listApiResources(environment: Environment): Promise<ApiResourceDiscovery> {
    discoveryInput.parse({ environment });
    const signal = AbortSignal.timeout(30_000);
    const [core, grouped] = await Promise.all([
      this.request(environment, '/api', { signal }),
      this.request(environment, '/apis', { signal }),
    ]);
    const versions: Array<{ group: string; version: string }> = [];
    for (const version of array(object(core).versions)) {
      const selected = resourceTypeInput.parse({ environment, group: '', version, kind: 'Discovery' });
      versions.push({ group: '', version: selected.version });
    }
    for (const raw of array(object(grouped).groups)) {
      const group = object(raw);
      for (const rawVersion of array(group.versions)) {
        const selected = resourceTypeInput.parse({ environment, group: group.name, version: object(rawVersion).version, kind: 'Discovery' });
        versions.push({ group: selected.group, version: selected.version });
      }
    }
    const unique = [...new Map(versions.map(version => [apiVersion(version.group, version.version), version])).values()];
    if (unique.length > MAX_DISCOVERY_VERSIONS) throw new Error(`Kubernetes discovery exceeds ${MAX_DISCOVERY_VERSIONS} API versions`);
    const result: ApiResourceDiscovery = { environment, resources: [], errors: [] };
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
      while (next < unique.length) {
        signal.throwIfAborted();
        const { group, version } = unique[next++];
        let resources: ApiResource[];
        try {
          resources = await this.resources(environment, group, version, signal);
        } catch (failure) {
          signal.throwIfAborted();
          result.errors.push({ group, version, error: failure instanceof Error ? failure.message.slice(0, 1024) : 'Kubernetes discovery failed' });
          continue;
        }
        if (result.resources.length + resources.length > MAX_DISCOVERY_RESOURCES) throw new Error(`Kubernetes discovery exceeds ${MAX_DISCOVERY_RESOURCES} resources`);
        result.resources.push(...resources);
      }
    }));
    result.resources.sort((a, b) => `${a.group}/${a.version}/${a.name}`.localeCompare(`${b.group}/${b.version}/${b.name}`));
    result.errors.sort((a, b) => `${a.group}/${a.version}`.localeCompare(`${b.group}/${b.version}`));
    return result;
  }

  private async collection(selection: ResourceTypeSelection, verb: 'list' | 'get', signal: AbortSignal): Promise<{ resource: ApiResource; path: string }> {
    const resources = await this.resources(selection.environment, selection.group, selection.version, signal);
    const matching = resources.filter(resource => resource.kind === selection.kind);
    if (matching.length !== 1) throw new Error(`Expected one Kubernetes resource for ${apiVersion(selection.group, selection.version)} kind ${selection.kind}; found ${matching.length}`);
    const resource = matching[0];
    if (!resource.verbs.includes(verb)) throw new Error(`Kubernetes resource ${resource.name} does not support ${verb}`);
    if (!resource.namespaced && selection.namespace) throw new Error(`Kubernetes kind ${selection.kind} is cluster-scoped; omit namespace`);
    if (resource.namespaced && verb === 'get' && !selection.namespace) throw new Error(`namespace is required to get Kubernetes kind ${selection.kind}`);
    const namespace = resource.namespaced && selection.namespace ? `/namespaces/${selection.namespace}` : '';
    return { resource, path: `${versionPath(selection.group, selection.version)}${namespace}/${resource.name}` };
  }

  async listResources(options: ListResourceOptions): Promise<KubernetesMetadataList> {
    const selected = listResourceInput.parse(options);
    const signal = AbortSignal.timeout(30_000);
    const { resource, path } = await this.collection(selected, 'list', signal);
    const limit = selected.limit ?? DEFAULT_PAGE_LIMIT;
    const query = new URLSearchParams({ limit: String(limit) });
    if (selected.continue) query.set('continue', selected.continue);
    const response = object(await this.request(selected.environment, `${path}?${query}`, { accept: METADATA_LIST_ACCEPT, signal }));
    const items = array(response.items);
    if (items.length > limit) throw new Error('Kubernetes API returned more objects than the requested page limit');
    return {
      environment: selected.environment, group: selected.group, version: selected.version, kind: selected.kind,
      resource: resource.name, metadata: object(response.metadata ?? {}),
      items: items.map(raw => ({ apiVersion: apiVersion(selected.group, selected.version), kind: selected.kind, metadata: object(object(raw).metadata) })),
    };
  }

  async getResource(options: GetResourceOptions): Promise<Record<string, unknown>> {
    const selected = getResourceInput.parse(options);
    const signal = AbortSignal.timeout(30_000);
    const { path } = await this.collection(selected, 'get', signal);
    return object(await this.request(selected.environment, `${path}/${encodeURIComponent(selected.name)}`, { signal }));
  }
}
