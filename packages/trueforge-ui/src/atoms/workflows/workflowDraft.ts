import type {
  WorkflowEdge,
  WorkflowManifest,
  WorkflowNode,
  WorkflowRunStep,
  WorkflowTrigger,
} from '../../server/types.js';

export type WorkflowDraft = { name: string; manifest: WorkflowManifest };
export type WorkflowNodeType = WorkflowNode['type'];

export type WorkflowNodeCategory = 'core' | 'flow' | 'data';

type NodeTypeInfo = {
  label: string;
  icon: string;
  description: string;
  category: WorkflowNodeCategory;
  /** Prefix for generated step ids, e.g. `http_1`. */
  idPrefix: string;
};

/** One entry per node type; the picker, canvas, and inspector all read from here. */
export const NODE_TYPES: Record<WorkflowNodeType, NodeTypeInfo> = {
  http_request: {
    label: 'HTTP request',
    icon: 'globe-2',
    description: 'Call any API or URL.',
    category: 'core',
    idPrefix: 'http',
  },
  transform: {
    label: 'Edit fields',
    icon: 'pencil',
    description: 'Build an object from templates.',
    category: 'core',
    idPrefix: 'fields',
  },
  agent: {
    label: 'Agent',
    icon: 'agent-2',
    description: 'Let an agent handle a judgment call.',
    category: 'core',
    idPrefix: 'agent',
  },
  condition: {
    label: 'If',
    icon: 'git-fork',
    description: 'Route to true or false.',
    category: 'flow',
    idPrefix: 'if',
  },
  switch: {
    label: 'Switch',
    icon: 'list-ol',
    description: 'Route to one of several branches.',
    category: 'flow',
    idPrefix: 'switch',
  },
  merge: {
    label: 'Merge',
    icon: 'layers',
    description: 'Join branches back together.',
    category: 'flow',
    idPrefix: 'merge',
  },
  wait: {
    label: 'Wait',
    icon: 'clock',
    description: 'Pause before continuing.',
    category: 'flow',
    idPrefix: 'wait',
  },
  stop_and_error: {
    label: 'Stop and error',
    icon: 'circle-xmark',
    description: 'Fail the run with a message.',
    category: 'flow',
    idPrefix: 'stop',
  },
  no_op: {
    label: 'No operation',
    icon: 'circle-check',
    description: 'Pass data through unchanged.',
    category: 'flow',
    idPrefix: 'noop',
  },
  filter: {
    label: 'Filter',
    icon: 'funnel',
    description: 'Keep list items that match a rule.',
    category: 'data',
    idPrefix: 'filter',
  },
  sort: {
    label: 'Sort',
    icon: 'arrow-down',
    description: 'Order list items by a field.',
    category: 'data',
    idPrefix: 'sort',
  },
  limit: {
    label: 'Limit',
    icon: 'compress',
    description: 'Keep the first or last items.',
    category: 'data',
    idPrefix: 'limit',
  },
  remove_duplicates: {
    label: 'Remove duplicates',
    icon: 'copy',
    description: 'Drop repeated list items.',
    category: 'data',
    idPrefix: 'dedupe',
  },
  split_out: {
    label: 'Split out',
    icon: 'expand-alt',
    description: 'Turn a nested list into the list.',
    category: 'data',
    idPrefix: 'split',
  },
  aggregate: {
    label: 'Aggregate',
    icon: 'cube',
    description: 'Collect, count, sum, or average a field.',
    category: 'data',
    idPrefix: 'aggregate',
  },
  date_time: {
    label: 'Date & time',
    icon: 'calendar',
    description: 'Get, shift, and format dates.',
    category: 'data',
    idPrefix: 'date',
  },
  crypto: {
    label: 'Crypto',
    icon: 'lock',
    description: 'Hash, sign, or generate ids.',
    category: 'data',
    idPrefix: 'crypto',
  },
};

export const NODE_CATEGORIES: ReadonlyArray<{ id: WorkflowNodeCategory; label: string }> = [
  { id: 'core', label: 'Core' },
  { id: 'flow', label: 'Flow' },
  { id: 'data', label: 'Data transformation' },
];

export function nextNodeId({ type, nodes }: { type: WorkflowNodeType; nodes: readonly WorkflowNode[] }): string {
  const taken = new Set(nodes.map(node => node.id));
  const prefix = NODE_TYPES[type].idPrefix;
  let index = 1;
  while (taken.has(`${prefix}_${String(index)}`)) index += 1;
  return `${prefix}_${String(index)}`;
}

export function createNode({
  type,
  id,
  position,
}: {
  type: WorkflowNodeType;
  id: string;
  position: { x: number; y: number };
}): WorkflowNode {
  const base = { id, name: NODE_TYPES[type].label, position, onError: 'stop' as const };
  switch (type) {
    case 'http_request':
      return { ...base, type, method: 'GET', url: '', headers: {}, timeoutSeconds: 30 };
    case 'transform':
      return { ...base, type, values: {} };
    case 'condition':
      return { ...base, type, left: '', operator: 'equals', right: '' };
    case 'agent':
      return { ...base, type, agentName: '', task: '' };
    case 'switch':
      return { ...base, type, value: '', rules: [{ operator: 'equals', right: '' }] };
    case 'merge':
      return { ...base, type, mode: 'append' };
    case 'wait':
      return { ...base, type, seconds: 5 };
    case 'stop_and_error':
      return { ...base, type, message: '' };
    case 'no_op':
      return { ...base, type };
    case 'filter':
      return { ...base, type, input: '', field: '', operator: 'is_not_empty', right: '' };
    case 'sort':
      return { ...base, type, input: '', field: '', order: 'asc' };
    case 'limit':
      return { ...base, type, input: '', maxItems: 10, keep: 'first' };
    case 'remove_duplicates':
      return { ...base, type, input: '', field: '' };
    case 'split_out':
      return { ...base, type, input: '', field: '' };
    case 'aggregate':
      return { ...base, type, input: '', field: '', operation: 'collect' };
    case 'date_time':
      return { ...base, type, value: '', addAmount: 0, addUnit: 'days', timezone: 'UTC' };
    case 'crypto':
      return { ...base, type, operation: 'hash', algorithm: 'sha256', encoding: 'hex', value: '', secret: '' };
  }
}

/** Branch handles a node exposes, or `null` for a single plain output. */
export function nodeBranches(node: WorkflowNode): Array<{ id: string; label: string }> | null {
  switch (node.type) {
    case 'condition':
      return [
        { id: 'true', label: 'true' },
        { id: 'false', label: 'false' },
      ];
    case 'switch':
      return [
        ...node.rules.map((rule, index) => ({ id: String(index), label: `${String(index)}: ${rule.operator}` })),
        { id: 'fallback', label: 'fallback' },
      ];
    default:
      return null;
  }
}

/** Places a new node just right of the rightmost one so it never lands on top of another. */
export function nextNodePosition(nodes: readonly WorkflowNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 80, y: 120 };
  const rightmost = nodes.reduce((best, node) => (node.position.x > best.position.x ? node : best));
  return { x: rightmost.position.x + 280, y: rightmost.position.y };
}

export function removeNode({ manifest, nodeId }: { manifest: WorkflowManifest; nodeId: string }): WorkflowManifest {
  return {
    ...manifest,
    nodes: manifest.nodes.filter(node => node.id !== nodeId),
    edges: manifest.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId),
  };
}

/** Renames a node and every edge and template that points at it, so a rename cannot break the graph. */
export function renameNodeId({
  manifest,
  from,
  to,
}: {
  manifest: WorkflowManifest;
  from: string;
  to: string;
}): WorkflowManifest {
  const reference = new RegExp(`(\\{\\{\\s*nodes\\.)${from}(\\.|\\s*\\}\\})`, 'g');
  const retarget = (text: string) => text.replace(reference, `$1${to}$2`);
  const nodes = manifest.nodes.map((node): WorkflowNode => {
    const renamed = node.id === from ? { ...node, id: to } : node;
    switch (renamed.type) {
      case 'http_request':
        return {
          ...renamed,
          url: retarget(renamed.url),
          headers: Object.fromEntries(Object.entries(renamed.headers).map(([k, v]) => [k, retarget(v)])),
          ...(renamed.body === undefined ? {} : { body: retarget(renamed.body) }),
        };
      case 'transform':
        return {
          ...renamed,
          values: Object.fromEntries(Object.entries(renamed.values).map(([k, v]) => [k, retarget(v)])),
        };
      case 'condition':
        return { ...renamed, left: retarget(renamed.left), right: retarget(renamed.right) };
      case 'agent':
        return { ...renamed, task: retarget(renamed.task) };
      case 'switch':
        return {
          ...renamed,
          value: retarget(renamed.value),
          rules: renamed.rules.map(rule => ({ ...rule, right: retarget(rule.right) })),
        };
      case 'stop_and_error':
        return { ...renamed, message: retarget(renamed.message) };
      case 'filter':
        return { ...renamed, input: retarget(renamed.input), right: retarget(renamed.right) };
      case 'sort':
      case 'limit':
      case 'remove_duplicates':
      case 'split_out':
      case 'aggregate':
        return { ...renamed, input: retarget(renamed.input) };
      case 'date_time':
        return { ...renamed, value: retarget(renamed.value) };
      case 'crypto':
        return { ...renamed, value: retarget(renamed.value), secret: retarget(renamed.secret) };
      case 'merge':
      case 'wait':
      case 'no_op':
        return renamed;
    }
  });
  const edges = manifest.edges.map(edge => ({
    ...edge,
    source: edge.source === from ? to : edge.source,
    target: edge.target === from ? to : edge.target,
  }));
  return { ...manifest, nodes, edges };
}

/**
 * Adds a step of `type`, connected after `after` when given, the way n8n's "+" on a node works.
 * Returns the new manifest and the id the step received.
 */
export function addStep({
  manifest,
  type,
  after,
}: {
  manifest: WorkflowManifest;
  type: WorkflowNodeType;
  after?: { source: string; branch?: string };
}): { manifest: WorkflowManifest; id: string } {
  const id = nextNodeId({ type, nodes: manifest.nodes });
  const source = after === undefined ? undefined : manifest.nodes.find(node => node.id === after.source);
  const siblings = source === undefined ? 0 : manifest.edges.filter(edge => edge.source === source.id).length;
  const position =
    source === undefined
      ? nextNodePosition(manifest.nodes)
      : { x: source.position.x + 280, y: source.position.y + siblings * 120 };
  const node = createNode({ type, id, position });
  const edges: WorkflowEdge[] =
    after === undefined || source === undefined
      ? manifest.edges
      : [
          ...manifest.edges,
          { source: source.id, target: id, ...(after.branch === undefined ? {} : { branch: after.branch }) },
        ];
  return { manifest: { ...manifest, nodes: [...manifest.nodes, node], edges }, id };
}

/** Drops one switch rule; its edges go, and later rules' edges shift down to keep pointing at the same rule. */
export function removeSwitchRule({
  manifest,
  nodeId,
  index,
}: {
  manifest: WorkflowManifest;
  nodeId: string;
  index: number;
}): WorkflowManifest {
  const nodes = manifest.nodes.map(node =>
    node.id === nodeId && node.type === 'switch'
      ? { ...node, rules: node.rules.filter((_rule, ruleIndex) => ruleIndex !== index) }
      : node,
  );
  const edges = manifest.edges.flatMap(edge => {
    if (edge.source !== nodeId || edge.branch === undefined || !/^\d$/.test(edge.branch)) return [edge];
    const branch = Number(edge.branch);
    if (branch === index) return [];
    return [branch > index ? { ...edge, branch: String(branch - 1) } : edge];
  });
  return { ...manifest, nodes, edges };
}

/** Would adding `source -> target` close a loop? Checked on connect so the canvas can refuse it. */
export function wouldCreateCycle({
  edges,
  source,
  target,
}: {
  edges: readonly WorkflowEdge[];
  source: string;
  target: string;
}): boolean {
  const pending = [target];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    if (current === source) return true;
    seen.add(current);
    for (const edge of edges) {
      if (edge.source === current) pending.push(edge.target);
    }
  }
  return false;
}

export type WorkflowTriggerType = WorkflowTrigger['type'];

export const TRIGGER_TYPE_LABELS: Record<WorkflowTriggerType, string> = {
  manual: 'Manual',
  cron: 'Schedule',
  webhook: 'Webhook',
};

/** A workflow can have several schedules but only one manual and one webhook trigger. */
export function canAddTrigger({
  triggers,
  type,
}: {
  triggers: readonly WorkflowTrigger[];
  type: WorkflowTriggerType;
}): boolean {
  return type === 'cron' || !triggers.some(trigger => trigger.type === type);
}

export function createTrigger(type: WorkflowTriggerType): WorkflowTrigger {
  return type === 'cron' ? { type, cron: '0 9 * * *', timezone: 'UTC' } : { type };
}

/** Problems worth catching before a round trip; the server stays the authority. */
export function draftProblems(draft: WorkflowDraft): string[] {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9-]{0,62}[a-z0-9]$/.test(draft.name)) {
    problems.push('Name must be 2–64 lowercase characters: start with a letter, then letters, digits, or hyphens.');
  }
  if (draft.manifest.nodes.length === 0) {
    problems.push('Add at least one step.');
  }
  if (draft.manifest.triggers.length === 0) {
    problems.push('Add at least one trigger.');
  }
  if (draft.manifest.triggers.some(trigger => trigger.type === 'cron' && trigger.cron.trim() === '')) {
    problems.push('Enter a cron expression for each schedule.');
  }
  for (const node of draft.manifest.nodes) {
    if (node.type === 'http_request' && node.url.trim() === '') problems.push(`${node.name}: enter a URL.`);
    if (node.type === 'agent' && node.agentName === '') problems.push(`${node.name}: pick an agent.`);
    if (node.type === 'agent' && node.task.trim() === '') problems.push(`${node.name}: write the task.`);
    if (node.type === 'stop_and_error' && node.message.trim() === '') problems.push(`${node.name}: write the message.`);
    if (node.type === 'split_out' && node.field.trim() === '') problems.push(`${node.name}: name the list field.`);
    if (node.type === 'crypto' && node.operation === 'hmac' && node.secret.trim() === '') {
      problems.push(`${node.name}: enter the HMAC secret.`);
    }
  }
  return problems;
}

export function stepStatusByNode(steps: readonly WorkflowRunStep[] | undefined): Map<string, WorkflowRunStep> {
  return new Map((steps ?? []).map(step => [step.nodeId, step]));
}

const position = (index: number, y = 120) => ({ x: 80 + index * 280, y });

export type WorkflowTemplate = { id: string; label: string; description: string; draft: WorkflowDraft };

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: 'blank',
    label: 'Blank workflow',
    description: 'Start from an empty canvas.',
    draft: {
      name: 'my-workflow',
      manifest: { description: '', status: 'active', triggers: [{ type: 'manual' }], nodes: [], edges: [] },
    },
  },
  {
    id: 'uptime-check',
    label: 'Scheduled check',
    description: 'Call an endpoint on a schedule and alert when it is not healthy. No model involved.',
    draft: {
      name: 'uptime-check',
      manifest: {
        description: 'Checks an endpoint every hour and posts to a webhook if it reports a problem.',
        status: 'active',
        triggers: [{ type: 'cron', cron: '0 * * * *', timezone: 'UTC' }],
        nodes: [
          {
            id: 'check',
            name: 'Call endpoint',
            position: position(0),
            onError: 'continue',
            type: 'http_request',
            method: 'GET',
            url: 'https://example.com/health',
            headers: {},
            timeoutSeconds: 30,
          },
          {
            id: 'healthy',
            name: 'Is it healthy?',
            position: position(1),
            onError: 'stop',
            type: 'condition',
            left: '{{ nodes.check.output.status }}',
            operator: 'equals',
            right: '200',
          },
          {
            id: 'alert',
            name: 'Post alert',
            position: position(2, 220),
            onError: 'stop',
            type: 'http_request',
            method: 'POST',
            url: 'https://example.com/alerts',
            headers: { 'content-type': 'application/json' },
            body: '{"text":"Health check returned {{ nodes.check.output.status }}"}',
            timeoutSeconds: 30,
          },
        ],
        edges: [
          { source: 'check', target: 'healthy' },
          { source: 'healthy', target: 'alert', branch: 'false' },
        ],
      },
    },
  },
  {
    id: 'webhook-triage',
    label: 'Webhook with agent triage',
    description: 'Fixed process with one judgment call: an agent classifies each incoming item.',
    draft: {
      name: 'webhook-triage',
      manifest: {
        description: 'Receives an item, asks an agent to assess it, and forwards the result.',
        status: 'active',
        triggers: [{ type: 'webhook' }],
        nodes: [
          {
            id: 'assess',
            name: 'Assess item',
            position: position(0),
            onError: 'stop',
            type: 'agent',
            agentName: '',
            task: 'Assess this item and reply with one short paragraph:\n\n{{ trigger.body }}',
          },
          {
            id: 'forward',
            name: 'Forward result',
            position: position(1),
            onError: 'stop',
            type: 'http_request',
            method: 'POST',
            url: 'https://example.com/inbox',
            headers: { 'content-type': 'text/plain' },
            body: '{{ nodes.assess.output.text }}',
            timeoutSeconds: 30,
          },
        ],
        edges: [{ source: 'assess', target: 'forward' }],
      },
    },
  },
];
