import { z } from 'zod';
import { ENVIRONMENTS, type Environment } from '../local-dev.js';

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;
export const METADATA_LIST_ACCEPT = 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json;q=0.9';

export const discoveryInput = z.object({ environment: z.enum(ENVIRONMENTS) }).strict();
export const resourceTypeInput = discoveryInput.extend({
  group: z.string().max(253).regex(/^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/).describe('API group; use an empty string for core resources'),
  version: z.string().min(1).max(63).regex(/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/),
  kind: z.string().min(1).max(128).regex(/^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/),
  namespace: z.string().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).optional(),
}).strict();
export const listResourceInput = resourceTypeInput.extend({
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional().describe(`Page size (default ${DEFAULT_PAGE_LIMIT}, maximum ${MAX_PAGE_LIMIT})`),
  continue: z.string().min(1).max(8192).optional().describe('Opaque continuation token from the previous page'),
}).strict();
export const getResourceInput = resourceTypeInput.extend({
  name: z.string().min(1).max(253).regex(/^[A-Za-z0-9_.:-]+$/).refine(name => name !== '.' && name !== '..'),
}).strict();

export type ResourceTypeSelection = z.infer<typeof resourceTypeInput>;
export type ListResourceOptions = z.infer<typeof listResourceInput>;
export type GetResourceOptions = z.infer<typeof getResourceInput>;

export interface ApiResource {
  group: string;
  version: string;
  kind: string;
  name: string;
  namespaced: boolean;
  verbs: string[];
}

export interface ApiResourceDiscovery {
  environment: Environment;
  resources: ApiResource[];
  errors: Array<{ group: string; version: string; error: string }>;
}

export interface KubernetesMetadataList {
  environment: Environment;
  group: string;
  version: string;
  kind: string;
  resource: string;
  metadata: Record<string, unknown>;
  items: Array<{ apiVersion: string; kind: string; metadata: Record<string, unknown> }>;
}
