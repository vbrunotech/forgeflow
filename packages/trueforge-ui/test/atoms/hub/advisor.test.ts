import { describe, expect, it } from 'vitest';

import { parseAdvisorReply } from '../../../src/atoms/hub/advisor.js';
import { createNode } from '../../../src/atoms/workflows/workflowDraft.js';
import { layoutSteps, toWorkflowName } from '../../../src/atoms/workflows/workflowSanitize.js';

const fence = (json: unknown) => `I recommend a workflow.\n\n\`\`\`forgeflow\n${JSON.stringify(json)}\n\`\`\``;

describe('parseAdvisorReply', () => {
  it('returns plain prose when there is no proposal', () => {
    expect(parseAdvisorReply('What triggers this?')).toEqual({ text: 'What triggers this?', proposal: null });
  });

  it('hides a proposal block that is still streaming', () => {
    expect(parseAdvisorReply('Use a workflow.\n```forgeflow\n{"kind":"wor').text).toBe('Use a workflow.');
  });

  it('turns a workflow proposal into an editor draft, keeping only known fields', () => {
    const { text, proposal } = parseAdvisorReply(
      fence({
        kind: 'workflow',
        name: 'Daily Health Check!',
        description: 'Checks the API',
        triggers: [
          { type: 'cron', cron: '0 9 * * *', timezone: 'Europe/Paris' },
          { type: 'webhook' },
          { type: 'webhook' },
        ],
        steps: [
          { id: 'check', type: 'http_request', name: 'Call API', url: 'https://example.com', bogus: 1 },
          { id: 'ok', type: 'condition', left: '{{ nodes.check.output.status }}', operator: 'equals', right: '200' },
          { id: 'alert', type: 'send_to_slack', name: 'Slack' },
          { id: 'Bad Id!', type: 'no_op' },
        ],
        edges: [
          { source: 'check', target: 'ok' },
          { source: 'ok', target: 'bad_id', branch: 'false' },
          { source: 'ok', target: 'alert', branch: 'true' },
        ],
      }),
    );
    expect(text).toBe('I recommend a workflow.');
    expect(proposal?.kind).toBe('workflow');
    if (proposal?.kind !== 'workflow') return;
    expect(proposal.name).toBe('daily-health-check');
    expect(proposal.skippedSteps).toEqual(['Slack']);
    const { manifest } = proposal.draft;
    // The repeated webhook is dropped: a workflow can have only one.
    expect(manifest.triggers).toEqual([
      { type: 'cron', cron: '0 9 * * *', timezone: 'Europe/Paris' },
      { type: 'webhook' },
    ]);
    expect(manifest.nodes.map(node => node.id)).toEqual(['check', 'ok', 'bad_id']);
    expect(manifest.nodes[0]).toMatchObject({
      type: 'http_request',
      name: 'Call API',
      method: 'GET',
      timeoutSeconds: 30,
    });
    expect(manifest.nodes[0]).not.toHaveProperty('bogus');
    // The edge to the skipped step is dropped; the rest keep their branch.
    expect(manifest.edges).toEqual([
      { source: 'check', target: 'ok' },
      { source: 'ok', target: 'bad_id', branch: 'false' },
    ]);
  });

  it('reads an agent proposal and ignores malformed JSON', () => {
    const agent = parseAdvisorReply(
      '```forgeflow\n{"kind":"agent","name":"triage","description":"d","instructions":"You triage."}\n```',
    );
    expect(agent.proposal).toEqual({ kind: 'agent', name: 'triage', description: 'd', instructions: 'You triage.' });
    expect(parseAdvisorReply('```forgeflow\n{not json}\n```').proposal).toBeNull();
  });

  it('still reads a single trigger from older replies', () => {
    const { proposal } = parseAdvisorReply(
      fence({ kind: 'workflow', name: 'x', trigger: { type: 'webhook' }, steps: [] }),
    );
    expect(proposal?.kind === 'workflow' ? proposal.draft.manifest.triggers : null).toEqual([{ type: 'webhook' }]);
  });
});

describe('advisor helpers', () => {
  it('coerces names into valid workflow names', () => {
    expect(toWorkflowName('Sync CRM → Sheets')).toBe('sync-crm-sheets');
    expect(toWorkflowName('123 go')).toBe('workflow-123-go');
    expect(toWorkflowName('!')).toBe('my-workflow');
  });

  it('lays steps out in columns by depth', () => {
    const node = (id: string) => createNode({ type: 'no_op', id, position: { x: 0, y: 0 } });
    const laid = layoutSteps({
      nodes: [node('a'), node('b'), node('c'), node('d')],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'd' },
        { source: 'c', target: 'd' },
      ],
    });
    expect(laid.map(n => n.position)).toEqual([
      { x: 80, y: 120 },
      { x: 360, y: 120 },
      { x: 360, y: 260 },
      { x: 640, y: 120 },
    ]);
  });
});
