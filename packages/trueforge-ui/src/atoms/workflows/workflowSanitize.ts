import type { WorkflowEdge, WorkflowNode, WorkflowTrigger } from '../../server/types.js';
import { createNode, NODE_TYPES, type WorkflowDraft, type WorkflowNodeType } from './workflowDraft.js';

/**
 * Turns loosely shaped workflow JSON (an advisor proposal, an imported file) into an editor draft.
 * Nothing here trusts its input: unknown steps are reported, not guessed, and the server
 * still validates everything when the person saves.
 */

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function isNodeType(value: unknown): value is WorkflowNodeType {
  return typeof value === 'string' && Object.hasOwn(NODE_TYPES, value);
}

/** Workflow names must be lowercase kebab-case; coerce whatever was written. */
export function toWorkflowName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  if (slug === '') return 'my-workflow';
  const named = /^[a-z]/.test(slug) ? slug : `workflow-${slug}`.slice(0, 64).replace(/-+$/, '');
  return named.length >= 2 ? named : 'my-workflow';
}

/** Step ids are identifiers; `taken` keeps them unique when several map to the same slug. */
export function toStepId({ raw, index, taken }: { raw: unknown; index: number; taken: ReadonlySet<string> }): string {
  const slug = text(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56);
  const base = /^[a-z][a-z0-9_]*$/.test(slug) ? slug : `step_${String(index + 1)}`;
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}_${String(suffix)}`;
  return id;
}

function toPosition(raw: unknown): { x: number; y: number } | null {
  if (!isObject(raw)) return null;
  const { x, y } = raw;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Starts from the step's defaults and copies only fields the defaults have, with the same JSON type.
 * Values the server would reject (an unknown method, say) still surface when the person saves.
 */
function buildStep(raw: JsonObject, id: string): WorkflowNode | null {
  if (!isNodeType(raw['type'])) return null;
  const base = createNode({ type: raw['type'], id, position: toPosition(raw['position']) ?? { x: 0, y: 0 } });
  const merged: JsonObject = { ...base };
  for (const [key, fallback] of Object.entries(base)) {
    if (key === 'id' || key === 'type' || key === 'position') continue;
    const value = raw[key];
    const sameShape =
      (Array.isArray(fallback) && Array.isArray(value)) ||
      (isObject(fallback) && isObject(value)) ||
      (typeof fallback !== 'object' && typeof value === typeof fallback);
    if (sameShape) merged[key] = value;
  }
  if (typeof raw['name'] === 'string' && raw['name'].trim() !== '') merged['name'] = raw['name'].trim();
  // Assigning onto the typed default keeps its discriminated `type`.
  return Object.assign(base, merged);
}

function toTrigger(raw: unknown): WorkflowTrigger {
  if (isObject(raw) && raw['type'] === 'cron' && typeof raw['cron'] === 'string') {
    return { type: 'cron', cron: raw['cron'], timezone: text(raw['timezone'], 'UTC') };
  }
  if (isObject(raw) && raw['type'] === 'webhook') return { type: 'webhook' };
  return { type: 'manual' };
}

/** Accepts `triggers` or a single `trigger`; drops repeats the server would refuse. */
export function toTriggers(raw: JsonObject): WorkflowTrigger[] {
  const listed = Array.isArray(raw['triggers'])
    ? raw['triggers']
    : raw['trigger'] === undefined
      ? []
      : [raw['trigger']];
  const triggers: WorkflowTrigger[] = [];
  for (const candidate of listed.slice(0, 10).map(toTrigger)) {
    if (candidate.type === 'cron' || !triggers.some(existing => existing.type === candidate.type)) {
      triggers.push(candidate);
    }
  }
  return triggers.length === 0 ? [{ type: 'manual' }] : triggers;
}

/** Columns by longest path from a root, rows by order within a column. */
export function layoutSteps({ nodes, edges }: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }): WorkflowNode[] {
  const depth = new Map(nodes.map(node => [node.id, 0]));
  // Graphs are small (at most 50 steps), so relaxing every edge per step converges cheaply.
  for (let pass = 0; pass < nodes.length; pass += 1) {
    for (const edge of edges) {
      const next = (depth.get(edge.source) ?? 0) + 1;
      if (next > (depth.get(edge.target) ?? 0)) depth.set(edge.target, next);
    }
  }
  const rows = new Map<number, number>();
  return nodes.map(node => {
    const column = depth.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { ...node, position: { x: 80 + column * 280, y: 120 + row * 140 } };
  });
}

export type SanitizedWorkflow = {
  draft: WorkflowDraft;
  /** Steps that could not be used, so the person knows to add them by hand. */
  skippedSteps: string[];
};

/**
 * Reads `steps` (advisor) or `nodes` (export file). `keepLayout` keeps the file's positions when
 * every step has one; otherwise steps are laid out by depth.
 */
export function sanitizeWorkflowJson({ raw, keepLayout }: { raw: JsonObject; keepLayout: boolean }): SanitizedWorkflow {
  const name = toWorkflowName(text(raw['name'], 'my-workflow'));
  const description = text(raw['description']).slice(0, 500);
  const skippedSteps: string[] = [];
  const nodes: WorkflowNode[] = [];
  const idMap = new Map<string, string>();
  const rawSteps = Array.isArray(raw['steps']) ? raw['steps'] : Array.isArray(raw['nodes']) ? raw['nodes'] : [];
  for (const [index, rawStep] of rawSteps.entries()) {
    if (!isObject(rawStep)) continue;
    const id = toStepId({ raw: rawStep['id'], index, taken: new Set(nodes.map(node => node.id)) });
    const node = buildStep(rawStep, id);
    if (node == null) {
      skippedSteps.push(text(rawStep['name'], text(rawStep['type'], `step ${String(index + 1)}`)));
      continue;
    }
    // Edges may name a step by its original id or by the cleaned one.
    idMap.set(text(rawStep['id'], id), id);
    idMap.set(id, id);
    nodes.push(node);
  }
  const edges: WorkflowEdge[] = (Array.isArray(raw['edges']) ? raw['edges'] : []).flatMap(rawEdge => {
    if (!isObject(rawEdge)) return [];
    const source = idMap.get(text(rawEdge['source']));
    const target = idMap.get(text(rawEdge['target']));
    if (source === undefined || target === undefined || source === target) return [];
    const branch = rawEdge['branch'];
    return [{ source, target, ...(typeof branch === 'string' && branch !== '' ? { branch } : {}) }];
  });
  const allPlaced = rawSteps.every(rawStep => isObject(rawStep) && toPosition(rawStep['position']) != null);
  return {
    skippedSteps,
    draft: {
      name,
      manifest: {
        description,
        status: 'active',
        triggers: toTriggers(raw),
        nodes: keepLayout && allPlaced ? nodes : layoutSteps({ nodes, edges }),
        edges,
      },
    },
  };
}
