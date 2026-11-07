import type { Context } from 'hono';
import type { ScheduleTurnExecutionDeps } from '../../apis/schedules';
import { beginTurnExecution, drainTurnEvents } from '../../apis/turns';
import type { WorkflowRecord, WorkflowRunRecord } from '../../db/workflowStore';
import type { WorkflowStepHandlers, WorkflowStepResult } from './engine';
import { WorkflowStepError } from './stepError';
import { renderTemplate } from './template';

export type WorkflowTurnDeps<TTransaction> = Omit<ScheduleTurnExecutionDeps<TTransaction>, 'scheduleStore'>;

type AgentStepInput = Parameters<WorkflowStepHandlers['agent']>[0];

function messageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .flatMap((part: unknown) =>
      typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('');
}

/**
 * Runs one agent turn to completion and returns its final message. There is nobody to answer
 * during a run, so an agent that stops for approval or input fails the step rather than hanging.
 */
export async function runWorkflowAgentStep<TTransaction>(
  params: AgentStepInput & {
    c: Context;
    workflow: WorkflowRecord;
    run: WorkflowRunRecord;
    deps: WorkflowTurnDeps<TTransaction>;
  },
): Promise<WorkflowStepResult> {
  const { node, context, onSession, c, workflow, run, deps } = params;
  const agent = await deps.agentStore.getAgent({ tenant_id: workflow.tenant_id, name: node.agent_name });
  if (agent === undefined) {
    throw new WorkflowStepError(`Agent not found: ${node.agent_name}`);
  }

  const { session } = await deps.sessions.getOrCreateByExternalId({
    tenant_id: workflow.tenant_id,
    external_id: `${run.id}:${node.id}`,
    created_by_subject: workflow.created_by_subject,
    agent: { type: 'reference', id: agent.id, name: agent.name },
    metadata: { 'tfg.source': 'workflow', 'tfg.workflow_id': workflow.id, 'tfg.workflow_run_id': run.id },
  });
  await onSession(session.session_id);

  const { turn, drainInput } = await beginTurnExecution({
    session,
    input: [{ type: 'user.message', content: renderTemplate({ template: node.task, context }) }],
    previous_turn_id: 'none',
    userRef: workflow.created_by_subject.subject_id,
    deps: {
      activeTurns: deps.activeTurns,
      eventSubscriptions: deps.eventSubscriptions,
      agentStore: deps.agentStore,
      modelProviderStore: deps.resolveModelProviderStore({ c, runAsAgent: agent }),
      mcpServerStore: deps.resolveMcpServerStore({ c, runAsAgent: agent }),
      sandboxProviderStore: deps.resolveSandboxProviderStore(c),
      sandboxEnvironmentStore: deps.sandboxEnvironmentStore,
      webSearchProviderStore: deps.resolveWebSearchProviderStore(c),
      skillStore: deps.resolveTurnSkillsStore({}),
      capabilitiesStore: deps.resolveCapabilitiesStore({}),
      // Same rule as schedules: unattended sessions never read or write memory.
      memory: undefined,
      logger: deps.logger,
    },
  });
  await drainTurnEvents(drainInput);

  const finished = await session.getTurn(turn.id);
  const state = finished?.state;
  const base = { session_id: session.session_id };
  const waitingForHuman = 'The agent stopped to wait for approval or input, which a workflow cannot provide';
  switch (state?.status) {
    case 'done':
      if (state.required_actions.length > 0) {
        throw new WorkflowStepError(waitingForHuman, { output: base });
      }
      return { ...base, output: { text: messageText(state.output?.content), session_id: session.session_id } };
    case 'paused':
      throw new WorkflowStepError(waitingForHuman, { output: base });
    case 'error':
      throw new WorkflowStepError(state.message, { output: base });
    case 'cancelled':
      throw new WorkflowStepError(`The agent turn was cancelled: ${state.reason}`, { output: base });
    case 'running':
    case undefined:
      throw new WorkflowStepError('The agent turn ended without a final state', { output: base });
  }
}
