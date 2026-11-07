import type { Sessions } from '@truefoundry/trueforge-core/agent-session';
import type { Context } from 'hono';
import { beginTurnExecution, drainTurnEvents } from '../../../../src/apis/turns';
import type { WorkflowRecord, WorkflowRunRecord } from '../../../../src/db/workflowStore';
import { runWorkflowAgentStep } from '../../../../src/runtime/workflow/agentStep';
import { WorkflowManifestSchema, type WorkflowAgentNode } from '../../../../src/schemas/workflow';

jest.mock('../../../../src/apis/turns', () => ({
  beginTurnExecution: jest.fn(),
  drainTurnEvents: jest.fn().mockResolvedValue(undefined),
}));

const created_by_subject = { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' };
const node: WorkflowAgentNode = {
  id: 'think',
  name: 'Think',
  position: { x: 0, y: 0 },
  on_error: 'stop',
  type: 'agent',
  agent_name: 'reporter',
  task: 'Summarise {{ trigger.body.topic }}',
};
const manifest = WorkflowManifestSchema.parse({ triggers: [{ type: 'manual' }], nodes: [node] });
const workflow: WorkflowRecord = {
  id: 'wf-1',
  tenant_id: 'default',
  name: 'flow',
  manifest,
  status: 'active',
  webhook_token_hash: null,
  next_run_at: null,
  created_by_subject,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const run: WorkflowRunRecord = {
  id: 'run-1',
  tenant_id: 'default',
  workflow_id: 'wf-1',
  status: 'running',
  trigger_type: 'manual',
  input: {},
  manifest,
  steps: [],
  error: null,
  created_by_subject,
  created_at: '2026-01-01T00:00:00.000Z',
  finished_at: null,
};

const mockedBegin = jest.mocked(beginTurnExecution);

function setup(finalState: object, agent: object | null = { id: 'a1', name: 'reporter' }) {
  const session = { session_id: 's1', getTurn: jest.fn().mockResolvedValue({ state: finalState }) };
  const getOrCreateByExternalId = jest.fn().mockResolvedValue({ session });
  mockedBegin.mockReset();
  mockedBegin.mockResolvedValue({ turn: { id: 't1' }, drainInput: {} } as never);
  const onSession = jest.fn().mockResolvedValue(undefined);
  const deps = {
    sessions: { getOrCreateByExternalId } as unknown as Sessions,
    agentStore: { getAgent: jest.fn().mockResolvedValue(agent ?? undefined) },
    activeTurns: {},
    eventSubscriptions: {},
    logger: {},
    resolveModelProviderStore: () => ({}),
    resolveMcpServerStore: () => ({}),
    resolveSandboxProviderStore: () => ({}),
    sandboxEnvironmentStore: {},
    resolveWebSearchProviderStore: () => ({}),
    resolveTurnSkillsStore: () => ({}),
    resolveCapabilitiesStore: () => ({}),
  } as never;
  const call = () =>
    runWorkflowAgentStep({
      node,
      context: { trigger: { body: { topic: 'news' } }, nodes: {} },
      signal: new AbortController().signal,
      onSession,
      c: {} as Context,
      workflow,
      run,
      deps,
    });
  return { call, onSession, getOrCreateByExternalId };
}

describe('runWorkflowAgentStep', () => {
  it('runs one turn with the rendered task as the workflow creator and returns the final text', async () => {
    const { call, onSession, getOrCreateByExternalId } = setup({
      status: 'done',
      required_actions: [],
      output: {
        content: [
          { type: 'text', text: 'All ' },
          { type: 'text', text: 'good' },
        ],
      },
    });
    await expect(call()).resolves.toEqual({ session_id: 's1', output: { text: 'All good', session_id: 's1' } });
    expect(onSession).toHaveBeenCalledWith('s1');
    expect(jest.mocked(drainTurnEvents)).toHaveBeenCalled();
    expect(getOrCreateByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        external_id: 'run-1:think',
        created_by_subject,
        metadata: expect.objectContaining({ 'tfg.source': 'workflow', 'tfg.workflow_run_id': 'run-1' }),
      }),
    );
    expect(mockedBegin.mock.calls[0]?.[0]).toMatchObject({
      input: [{ type: 'user.message', content: 'Summarise news' }],
      userRef: 'alice',
      deps: { memory: undefined },
    });
  });

  it.each([
    ['pending approval', { status: 'done', required_actions: [{}], output: null }, /approval or input/],
    ['a paused turn', { status: 'paused', action_required_on_events: [] }, /approval or input/],
    ['an errored turn', { status: 'error', message: 'model down' }, /model down/],
    ['a cancelled turn', { status: 'cancelled', reason: 'timeout' }, /cancelled/],
  ])('fails the step on %s', async (_label, state, message) => {
    await expect(setup(state).call()).rejects.toThrow(message);
  });

  it('fails when the agent no longer exists', async () => {
    const session = { status: 'done', required_actions: [], output: null };
    const { call } = setup(session, null);
    await expect(call()).rejects.toThrow('Agent not found: reporter');
  });
});
