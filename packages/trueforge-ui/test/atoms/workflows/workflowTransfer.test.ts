import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNode, type WorkflowDraft } from '../../../src/atoms/workflows/workflowDraft.js';
import {
  exportForgeflowJson,
  exportN8nJson,
  mergeImportedWorkflow,
  parseWorkflowImport,
} from '../../../src/atoms/workflows/workflowTransfer.js';

const draft: WorkflowDraft = {
  name: 'health-check',
  manifest: {
    description: 'Checks the API',
    status: 'active',
    triggers: [{ type: 'manual' }, { type: 'cron', cron: '0 9 * * 1', timezone: 'UTC' }],
    nodes: [
      {
        id: 'fetch',
        name: 'Fetch',
        position: { x: 80, y: 120 },
        onError: 'continue',
        type: 'http_request',
        method: 'GET',
        url: 'https://example.com/{{ trigger.body.path }}',
        headers: { accept: 'application/json' },
        timeoutSeconds: 20,
      },
      {
        id: 'ok',
        name: 'OK?',
        position: { x: 360, y: 120 },
        onError: 'stop',
        type: 'condition',
        left: '{{ nodes.fetch.output.status }}',
        operator: 'equals',
        right: '200',
      },
      { ...createNode({ type: 'no_op', id: 'done', position: { x: 640, y: 60 } }), name: 'Done' },
      {
        id: 'fail',
        name: 'Fail',
        position: { x: 640, y: 200 },
        onError: 'stop',
        type: 'stop_and_error',
        message: 'Status {{ nodes.fetch.output.status }}',
      },
    ],
    edges: [
      { source: 'fetch', target: 'ok' },
      { source: 'ok', target: 'done', branch: 'true' },
      { source: 'ok', target: 'fail', branch: 'false' },
    ],
  },
};

const N8nOut = z.object({
  nodes: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      parameters: z.record(z.string(), z.unknown()),
      onError: z.string().optional(),
    }),
  ),
  connections: z.record(
    z.string(),
    z.object({ main: z.array(z.array(z.object({ node: z.string(), type: z.string(), index: z.number() }))) }),
  ),
});

function parseN8n(json: string): z.infer<typeof N8nOut> {
  return N8nOut.parse(JSON.parse(json));
}

describe('Forgeflow format', () => {
  it('round-trips a workflow exactly', () => {
    const imported = parseWorkflowImport(exportForgeflowJson(draft));
    expect(imported.format).toBe('forgeflow');
    expect(imported.warnings).toEqual([]);
    expect(imported.draft).toEqual(draft);
  });
});

describe('n8n export', () => {
  it('maps steps, triggers, branches and templates to n8n', () => {
    const out = parseN8n(exportN8nJson(draft));
    expect(out.nodes.map(node => node.type)).toEqual([
      'n8n-nodes-base.manualTrigger',
      'n8n-nodes-base.scheduleTrigger',
      'n8n-nodes-base.httpRequest',
      'n8n-nodes-base.if',
      'n8n-nodes-base.noOp',
      'n8n-nodes-base.stopAndError',
    ]);
    const http = out.nodes.find(node => node.name === 'Fetch');
    expect(http?.parameters['url']).toBe(
      "=https://example.com/{{ $('When clicking ‘Execute workflow’').item.json.body.path }}",
    );
    expect(http?.onError).toBe('continueRegularOutput');
    expect(out.nodes.find(node => node.name === 'Fail')?.parameters['errorMessage']).toBe(
      "=Status {{ $('Fetch').item.json.status }}",
    );
    // Both triggers start the first step; If output 0 is true, output 1 is false.
    expect(out.connections['When clicking ‘Execute workflow’']?.main[0]).toEqual([
      { node: 'Fetch', type: 'main', index: 0 },
    ]);
    expect(out.connections['Schedule Trigger']?.main[0]?.[0]?.node).toBe('Fetch');
    expect(out.connections['OK?']?.main[0]?.[0]?.node).toBe('Done');
    expect(out.connections['OK?']?.main[1]?.[0]?.node).toBe('Fail');
  });

  it('comes back with the same steps and links after a round trip', () => {
    const back = parseWorkflowImport(exportN8nJson(draft));
    expect(back.format).toBe('n8n');
    expect(back.draft.manifest.triggers).toEqual(draft.manifest.triggers);
    expect(back.draft.manifest.nodes.map(node => [node.name, node.type])).toEqual(
      draft.manifest.nodes.map(node => [node.name, node.type]),
    );
    const ids = new Map(back.draft.manifest.nodes.map(node => [node.id, node.name]));
    expect(back.draft.manifest.edges.map(edge => [ids.get(edge.source), ids.get(edge.target), edge.branch])).toEqual([
      ['Fetch', 'OK?', undefined],
      ['OK?', 'Done', 'true'],
      ['OK?', 'Fail', 'false'],
    ]);
    const fail = back.draft.manifest.nodes.find(node => node.name === 'Fail');
    expect(fail?.type === 'stop_and_error' ? fail.message : null).toBe('Status {{ nodes.fetch.output.status }}');
  });
});

describe('n8n import', () => {
  const n8nWorkflow = {
    name: 'Support Router',
    nodes: [
      {
        id: '1',
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [0, 0],
        parameters: { path: 'x' },
      },
      {
        id: '2',
        name: 'Every Monday',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [0, 200],
        parameters: {
          rule: { interval: [{ field: 'weeks', triggerAtDay: [1], triggerAtHour: 8, triggerAtMinute: 30 }] },
        },
      },
      {
        id: '3',
        name: 'Get ticket',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [220, 0],
        parameters: {
          method: 'POST',
          url: '=https://api.example.com/tickets/{{ $json.body.id }}',
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'X-Key', value: 'abc' }] },
          jsonBody: '={"q": "{{ $json.body.q }}"}',
          options: { timeout: 10000 },
        },
        onError: 'continueRegularOutput',
      },
      {
        id: '4',
        name: 'Is urgent?',
        type: 'n8n-nodes-base.if',
        typeVersion: 2,
        position: [440, 0],
        parameters: {
          conditions: {
            conditions: [
              {
                leftValue: '={{ $json.priority }}',
                rightValue: 'high',
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
        },
      },
      {
        id: '5',
        name: 'Shape',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [660, -100],
        parameters: {
          assignments: {
            assignments: [{ name: 'title', value: "={{ $('Get ticket').item.json.title }}", type: 'string' }],
          },
        },
      },
      {
        id: '6',
        name: 'Notify Slack',
        type: 'n8n-nodes-base.slack',
        typeVersion: 2,
        position: [880, -100],
        parameters: {},
      },
      {
        id: '7',
        name: 'Custom code',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [660, 100],
        parameters: { jsCode: 'return items;' },
      },
      { id: '8', name: 'Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, 400], parameters: {} },
    ],
    connections: {
      Webhook: { main: [[{ node: 'Get ticket', type: 'main', index: 0 }]] },
      'Every Monday': { main: [[{ node: 'Get ticket', type: 'main', index: 0 }]] },
      'Get ticket': { main: [[{ node: 'Is urgent?', type: 'main', index: 0 }]] },
      'Is urgent?': {
        main: [[{ node: 'Shape', type: 'main', index: 0 }], [{ node: 'Custom code', type: 'main', index: 0 }]],
      },
      Shape: { main: [[{ node: 'Notify Slack', type: 'main', index: 0 }]] },
    },
  };

  it('converts triggers, steps, branches and expressions, and reports what has no equivalent', () => {
    const result = parseWorkflowImport(JSON.stringify(n8nWorkflow));
    expect(result.format).toBe('n8n');
    const { manifest, name } = result.draft;
    expect(name).toBe('support-router');
    expect(manifest.triggers).toEqual([{ type: 'webhook' }, { type: 'cron', cron: '30 8 * * 1', timezone: 'UTC' }]);
    expect(manifest.nodes.map(node => [node.id, node.type])).toEqual([
      ['get_ticket', 'http_request'],
      ['is_urgent', 'condition'],
      ['shape', 'transform'],
      ['notify_slack', 'no_op'],
      ['custom_code', 'no_op'],
    ]);
    const [http, condition, shape] = manifest.nodes;
    expect(http).toMatchObject({
      method: 'POST',
      // `$json` right after a trigger reads the trigger.
      url: 'https://api.example.com/tickets/{{ trigger.body.id }}',
      headers: { 'X-Key': 'abc' },
      body: '{"q": "{{ trigger.body.q }}"}',
      timeoutSeconds: 10,
      onError: 'continue',
      position: { x: 308, y: 0 },
    });
    expect(condition).toMatchObject({
      left: '{{ nodes.get_ticket.output.priority }}',
      operator: 'equals',
      right: 'high',
    });
    expect(shape?.type === 'transform' ? shape.values : null).toEqual({ title: '{{ nodes.get_ticket.output.title }}' });
    expect(manifest.edges).toEqual([
      { source: 'get_ticket', target: 'is_urgent' },
      { source: 'is_urgent', target: 'shape', branch: 'true' },
      { source: 'is_urgent', target: 'custom_code', branch: 'false' },
      { source: 'shape', target: 'notify_slack' },
    ]);
    expect(result.warnings.join('\n')).toMatch(/Notify Slack.*No operation placeholder/);
    expect(result.warnings.join('\n')).toMatch(/Custom code.*No operation placeholder/);
  });

  it('keeps JavaScript expressions it cannot translate and says so', () => {
    const workflow = {
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.manualTrigger', position: [0, 0], parameters: {} },
        {
          name: 'Set',
          type: 'n8n-nodes-base.set',
          position: [200, 0],
          parameters: { assignments: { assignments: [{ name: 'n', value: '={{ $json.a + 1 }}' }] } },
        },
      ],
      connections: { Start: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
    };
    const result = parseWorkflowImport(JSON.stringify(workflow));
    const set = result.draft.manifest.nodes[0];
    expect(set?.type === 'transform' ? set.values['n'] : null).toBe('{{ $json.a + 1 }}');
    expect(result.warnings.join('\n')).toMatch(/could not be translated/);
  });

  it('explains unreadable input', () => {
    expect(() => parseWorkflowImport('not json')).toThrow('not valid JSON');
    expect(() => parseWorkflowImport('{"hello": 1}')).toThrow('No workflow found');
  });
});

describe('mergeImportedWorkflow', () => {
  it('adds steps with fresh ids, to the right, keeping links and trigger rules', () => {
    const merged = mergeImportedWorkflow({ manifest: draft.manifest, imported: draft.manifest });
    expect(merged.addedSteps).toBe(4);
    // Manual is already there; a second identical schedule is allowed.
    expect(merged.addedTriggers).toBe(1);
    const ids = merged.manifest.nodes.map(node => node.id);
    expect(new Set(ids).size).toBe(8);
    const copy = merged.manifest.nodes[4];
    expect(copy?.id).toBe('fetch_2');
    expect(copy?.position.x).toBe(640 + 320);
    expect(merged.manifest.edges).toContainEqual({ source: 'fetch_2', target: 'ok_2' });
    const fail = merged.manifest.nodes.find(node => node.id === 'fail_2');
    expect(fail?.type === 'stop_and_error' ? fail.message : null).toBe('Status {{ nodes.fetch_2.output.status }}');
  });
});

describe('n8n node names with quotes', () => {
  it('escapes them on export and reads them back', () => {
    const quoted: WorkflowDraft = {
      ...draft,
      manifest: {
        ...draft.manifest,
        nodes: draft.manifest.nodes.map(node => (node.id === 'fetch' ? { ...node, name: "Bob's fetch" } : node)),
      },
    };
    const out = parseN8n(exportN8nJson(quoted));
    expect(out.nodes.find(node => node.name === 'Fail')?.parameters['errorMessage']).toBe(
      "=Status {{ $('Bob\\'s fetch').item.json.status }}",
    );
    const back = parseWorkflowImport(exportN8nJson(quoted));
    const fail = back.draft.manifest.nodes.find(node => node.name === 'Fail');
    expect(fail?.type === 'stop_and_error' ? fail.message : null).toBe('Status {{ nodes.bob_s_fetch.output.status }}');
  });
});
