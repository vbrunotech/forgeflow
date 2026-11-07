import { describe, expect, it } from 'vitest';

import {
  addStep,
  canAddTrigger,
  createNode,
  draftProblems,
  nextNodeId,
  nodeBranches,
  removeNode,
  removeSwitchRule,
  renameNodeId,
  WORKFLOW_TEMPLATES,
  wouldCreateCycle,
} from '../../../src/atoms/workflows/workflowDraft.js';
import type { WorkflowManifest } from '../../../src/server/types.js';

const position = { x: 0, y: 0 };
const manifest: WorkflowManifest = {
  description: '',
  status: 'active',
  triggers: [{ type: 'manual' }],
  nodes: [
    { ...createNode({ type: 'transform', id: 'first', position }), type: 'transform', values: { a: '1' } },
    {
      id: 'second',
      name: 'Second',
      position,
      onError: 'stop',
      type: 'transform',
      values: { copy: '{{ nodes.first.output.a }}', other: '{{nodes.firstish.output}}' },
    },
  ],
  edges: [{ source: 'first', target: 'second' }],
};

describe('workflow draft helpers', () => {
  it('generates the next free id', () => {
    const nodes = [createNode({ type: 'agent', id: 'agent_1', position })];
    expect(nextNodeId({ type: 'agent', nodes })).toBe('agent_2');
    expect(nextNodeId({ type: 'condition', nodes })).toBe('if_1');
  });

  it('removes a node with its edges', () => {
    const next = removeNode({ manifest, nodeId: 'first' });
    expect(next.nodes.map(node => node.id)).toEqual(['second']);
    expect(next.edges).toEqual([]);
  });

  it('renames an id everywhere it is referenced, without touching similar names', () => {
    const next = renameNodeId({ manifest, from: 'first', to: 'renamed' });
    expect(next.edges).toEqual([{ source: 'renamed', target: 'second' }]);
    const second = next.nodes[1];
    expect(second?.type === 'transform' ? second.values : null).toEqual({
      copy: '{{ nodes.renamed.output.a }}',
      other: '{{nodes.firstish.output}}',
    });
  });

  it('detects connections that would loop', () => {
    expect(wouldCreateCycle({ edges: manifest.edges, source: 'second', target: 'first' })).toBe(true);
    expect(wouldCreateCycle({ edges: manifest.edges, source: 'first', target: 'second' })).toBe(false);
    expect(wouldCreateCycle({ edges: [], source: 'a', target: 'a' })).toBe(true);
  });

  it('flags what the server would reject', () => {
    expect(draftProblems({ name: 'Not Valid', manifest: { ...manifest, nodes: [] } })).toHaveLength(2);
    const agent = createNode({ type: 'agent', id: 'agent_1', position });
    expect(draftProblems({ name: 'ok', manifest: { ...manifest, nodes: [agent] } })).toHaveLength(2);
    expect(draftProblems({ name: 'ok', manifest })).toEqual([]);
  });

  it('ships templates whose edges reference real nodes', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const ids = new Set(template.draft.manifest.nodes.map(node => node.id));
      for (const edge of template.draft.manifest.edges) {
        expect(ids.has(edge.source) && ids.has(edge.target)).toBe(true);
      }
    }
  });

  it('adds a step after a node and wires the chosen branch', () => {
    const added = addStep({ manifest, type: 'filter', after: { source: 'second' } });
    expect(added.id).toBe('filter_1');
    expect(added.manifest.edges).toContainEqual({ source: 'second', target: 'filter_1' });
    const branched = addStep({ manifest: added.manifest, type: 'no_op', after: { source: 'second', branch: 'x' } });
    expect(branched.manifest.edges).toContainEqual({ source: 'second', target: 'noop_1', branch: 'x' });
  });

  it('removes a switch rule and keeps later branches pointing at the same rule', () => {
    const route = {
      ...createNode({ type: 'switch', id: 'route', position }),
      type: 'switch' as const,
      value: '',
      rules: [
        { operator: 'equals' as const, right: 'a' },
        { operator: 'equals' as const, right: 'b' },
        { operator: 'equals' as const, right: 'c' },
      ],
    };
    const withSwitch: WorkflowManifest = {
      ...manifest,
      nodes: [...manifest.nodes, route],
      edges: [
        { source: 'route', target: 'first', branch: '0' },
        { source: 'route', target: 'second', branch: '2' },
        { source: 'route', target: 'second', branch: 'fallback' },
      ],
    };
    expect(nodeBranches(route)?.map(branch => branch.id)).toEqual(['0', '1', '2', 'fallback']);
    const next = removeSwitchRule({ manifest: withSwitch, nodeId: 'route', index: 0 });
    const updated = next.nodes.find(node => node.id === 'route');
    expect(updated?.type === 'switch' ? updated.rules.map(rule => rule.right) : null).toEqual(['b', 'c']);
    expect(next.edges).toEqual([
      { source: 'route', target: 'second', branch: '1' },
      { source: 'route', target: 'second', branch: 'fallback' },
    ]);
  });

  it('allows several schedules but only one manual and one webhook trigger', () => {
    const triggers = [{ type: 'manual' as const }, { type: 'cron' as const, cron: '0 9 * * *', timezone: 'UTC' }];
    expect(canAddTrigger({ triggers, type: 'cron' })).toBe(true);
    expect(canAddTrigger({ triggers, type: 'webhook' })).toBe(true);
    expect(canAddTrigger({ triggers, type: 'manual' })).toBe(false);
  });
});
