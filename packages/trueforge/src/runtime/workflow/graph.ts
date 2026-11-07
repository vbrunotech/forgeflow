import type { WorkflowEdge, WorkflowManifest, WorkflowNode } from '../../schemas/workflow';

/** The manifest parses but does not describe a runnable graph. */
export class InvalidWorkflowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidWorkflowError';
  }
}

/** Kahn's algorithm, ties broken by declaration order so a run's step order is stable. */
function topologicalOrder({ nodes, edges }: { nodes: readonly WorkflowNode[]; edges: readonly WorkflowEdge[] }) {
  const indegree = new Map(nodes.map(node => [node.id, 0]));
  for (const edge of edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const remaining = [...nodes];
  const ordered: WorkflowNode[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex(node => indegree.get(node.id) === 0);
    if (index === -1) {
      throw new InvalidWorkflowError(`Workflow has a cycle through: ${remaining.map(node => node.id).join(', ')}`);
    }
    const [next] = remaining.splice(index, 1);
    if (next === undefined) {
      break;
    }
    ordered.push(next);
    for (const edge of edges) {
      if (edge.source === next.id) {
        indegree.set(edge.target, (indegree.get(edge.target) ?? 0) - 1);
      }
    }
  }
  return ordered;
}

/** Branch names a node's outgoing edges must use, or `null` when its edges carry none. */
export function allowedBranches(node: WorkflowNode): string[] | null {
  switch (node.type) {
    case 'condition':
      return ['true', 'false'];
    case 'switch':
      return [...node.rules.map((_rule, index) => String(index)), 'fallback'];
    default:
      return null;
  }
}

/** Rejects graphs the engine cannot run. Returns nodes in execution order. */
export function validateWorkflowGraph(manifest: Pick<WorkflowManifest, 'nodes' | 'edges'>): WorkflowNode[] {
  const { nodes, edges } = manifest;
  const byId = new Map<string, WorkflowNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      throw new InvalidWorkflowError(`Duplicate node id: ${node.id}`);
    }
    byId.set(node.id, node);
  }

  const seen = new Set<string>();
  for (const edge of edges) {
    const source = byId.get(edge.source);
    if (source === undefined) {
      throw new InvalidWorkflowError(`Edge references unknown node: ${edge.source}`);
    }
    if (!byId.has(edge.target)) {
      throw new InvalidWorkflowError(`Edge references unknown node: ${edge.target}`);
    }
    const label = `${edge.source} -> ${edge.target}`;
    const allowed = allowedBranches(source);
    if (allowed === null && edge.branch !== undefined) {
      throw new InvalidWorkflowError(`Edge ${label} has a branch but ${edge.source} does not branch`);
    }
    if (allowed !== null && (edge.branch === undefined || !allowed.includes(edge.branch))) {
      throw new InvalidWorkflowError(`Edge ${label} needs one of these branches: ${allowed.join(', ')}`);
    }
    const key = `${edge.source}\0${edge.target}\0${edge.branch ?? ''}`;
    if (seen.has(key)) {
      throw new InvalidWorkflowError(`Duplicate edge: ${label}`);
    }
    seen.add(key);
  }

  return topologicalOrder({ nodes, edges });
}
