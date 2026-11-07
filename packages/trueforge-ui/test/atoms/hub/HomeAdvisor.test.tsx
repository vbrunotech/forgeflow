import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { HomeAdvisor } from '@/atoms/hub/HomeAdvisor.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider, useShellMode, type AgentConfig } from '@/server/ShellModeContext.js';
import type { CreateSessionRequest, TurnStreamData, WorkflowServer } from '@/server/types.js';

import { createMockAgentUIServer } from '../../server/mockServer.js';

const proposal = {
  kind: 'workflow',
  name: 'health-check',
  description: 'Checks the API every morning',
  triggers: [{ type: 'cron', cron: '0 9 * * *', timezone: 'UTC' }],
  steps: [{ id: 'check', type: 'http_request', name: 'Call API', url: 'https://example.com/health' }],
  edges: [],
};
const reply = `A workflow fits: the steps never change.\n\n\`\`\`forgeflow\n${JSON.stringify(proposal)}\n\`\`\``;

async function* replyStream(): AsyncIterable<TurnStreamData> {
  await Promise.resolve();
  yield { sequenceNumber: 1, event: { type: 'turn.created', id: 'e1', turnId: 'turn-1', createdAt: '' } };
  // Streamed in two pieces, then the final message replaces the deltas.
  yield { sequenceNumber: 2, event: { type: 'model.message.delta', id: 'm1', threadId: 'main', content: 'A work' } };
  yield {
    sequenceNumber: 3,
    event: { type: 'model.message', id: 'm1', threadId: 'main', content: reply, createdAt: '' },
  };
  yield {
    sequenceNumber: 4,
    event: { type: 'turn.done', id: 'e2', state: { status: 'done', completedAt: '' }, createdAt: '' },
  };
}

const unused = () => Promise.reject(new Error('not used by the advisor'));
const workflows: WorkflowServer = {
  listWorkflows: async () => ({ data: [] }),
  getWorkflow: unused,
  createWorkflow: unused,
  updateWorkflow: unused,
  deleteWorkflow: unused,
  createWebhookUrl: unused,
  runWorkflow: unused,
  listRuns: async () => ({ data: [] }),
  getRun: unused,
};

let shell: ReturnType<typeof useShellMode>;
function CaptureShell() {
  const value = useShellMode();
  useEffect(() => {
    shell = value;
  });
  return null;
}

function renderAdvisor({ modelName }: { modelName: string }) {
  const createSession = vi.fn((_req: CreateSessionRequest) =>
    Promise.resolve({ id: 'session-1', createdAt: '', updatedAt: '', isMutable: true }),
  );
  const createTurn = vi.fn(replyStream);
  const server = createMockAgentUIServer({ createSession, createTurn, workflows });
  const agentConfig: AgentConfig = {
    mode: 'AgentLibraryWithComposer',
    defaultAgentSpec: { model: { name: modelName } },
  };
  render(
    <ServerProvider server={server}>
      <ShellModeProvider agentConfig={agentConfig}>
        <CaptureShell />
        <HomeAdvisor />
      </ShellModeProvider>
    </ServerProvider>,
  );
  return { createSession, createTurn };
}

describe('HomeAdvisor', () => {
  it('asks the advisor and opens its workflow proposal in the editor', async () => {
    localStorage.clear();
    const { createSession, createTurn } = renderAdvisor({ modelName: 'openai/gpt-4.1' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe what you want to automate' }), {
      target: { value: 'Check my API every morning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const open = await screen.findByRole('button', { name: 'Open in workflow editor' });
    expect(screen.getByText('A workflow fits: the steps never change.')).toBeInTheDocument();
    expect(screen.queryByText(/"kind"/)).not.toBeInTheDocument();
    expect(createSession.mock.calls[0]?.[0].agentSpec?.instructions).toMatch(/Forgeflow advisor/);
    expect(createTurn.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-1',
      input: [{ type: 'user.message', content: 'Check my API every morning' }],
    });

    fireEvent.click(open);
    await waitFor(() => expect(shell.workflowsSection).toBe('new'));
    expect(shell.workflowDraftSeed?.name).toBe('health-check');
    expect(shell.workflowDraftSeed?.manifest.nodes[0]).toMatchObject({
      id: 'check',
      url: 'https://example.com/health',
    });
  });

  it('points to Settings when no model is configured', () => {
    localStorage.clear();
    renderAdvisor({ modelName: '' });
    expect(screen.getByText(/needs a model/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
