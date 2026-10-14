import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KubernetesClient } from '../kubernetes/client.js';
import { discoveryInput, getResourceInput, listResourceInput } from '../kubernetes/types.js';

export function registerKubernetesTools(server: McpServer, kubernetes: Pick<KubernetesClient, 'listApiResources' | 'listResources' | 'getResource'>): void {
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool('list_kubernetes_api_resources', {
    description: 'Discover the Kubernetes API resources available in the selected local environment using its fixed kubeconfig. Returns group, version, kind, plural resource name, namespace scope and supported verbs, with errors for API groups that could not be discovered.',
    inputSchema: discoveryInput,
    annotations,
  }, async ({ environment }) => {
    try {
      const result = await kubernetes.listApiResources(environment);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });

  server.registerTool('list_kubernetes_resources', {
    description: 'List Kubernetes resource metadata by group, version and kind in the selected local environment using its fixed kubeconfig. Use an empty group for core resources. Omit namespace to list across all namespaces; omit it for cluster-scoped resources. Returns metadata only and a bounded page with a continuation token when more results exist.',
    inputSchema: listResourceInput,
    annotations,
  }, async options => {
    try {
      const result = await kubernetes.listResources(options);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });

  server.registerTool('get_kubernetes_resource', {
    description: 'Get one Kubernetes resource with its full details by group, version, kind and name in the selected local environment using its fixed kubeconfig. Use an empty group for core resources. Namespace is required for namespaced resources and must be omitted for cluster-scoped resources.',
    inputSchema: getResourceInput,
    annotations,
  }, async options => {
    try {
      const result = await kubernetes.getResource(options);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });
}
