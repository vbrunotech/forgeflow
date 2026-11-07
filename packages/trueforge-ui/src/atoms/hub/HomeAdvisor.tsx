'use client';

import { useEffect, useRef, useState, type ComponentType, type FormEvent } from 'react';

import { useTrackAnalytics } from '../../analytics/AnalyticsProvider.js';
import { AnalyticsEvents } from '../../analytics/events.js';
import { Icon } from '../../icons/Icon.js';
import { useServer } from '../../server/ServerContext.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import type { TurnStreamingEvent } from '../../server/types.js';
import { getErrorMessage } from '../../utils/getErrorMessage.js';
import { cn } from '../lib/cn.js';
import { auiInputClass } from '../lib/inputClasses.js';
import { Markdown } from '../Markdown.js';
import { Badge } from '../primitives/Badge.js';
import { Button } from '../primitives/Button.js';
import { NODE_TYPES } from '../workflows/workflowDraft.js';
import { ADVISOR_INSTRUCTIONS, parseAdvisorReply, type AdvisorProposal } from './advisor.js';

export type HomeAdvisorProps = {
  className?: string;
};

type AdvisorMessage = { id: string; role: 'user' | 'assistant'; text: string; error?: boolean };

const SUGGESTIONS = [
  'Every morning, check our API health and alert Slack if it is down',
  'Read support emails and decide which team should handle each one',
  'When a form is submitted, save it and send a confirmation',
];

/** Text of a finished model message, whichever content shape the server used. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) =>
      typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : '',
    )
    .join('');
}

function ProposalCard({ proposal, onOpen }: { proposal: AdvisorProposal; onOpen: () => void }) {
  const isWorkflow = proposal.kind === 'workflow';
  return (
    <div className="mt-2 rounded-lg border border-border bg-primary-bg p-3">
      <div className="flex items-center gap-2">
        <Icon name={isWorkflow ? 'workflow' : 'agent-2'} className="size-4 text-text-secondary" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{proposal.name}</span>
        <Badge variant="outline">{isWorkflow ? 'Workflow' : 'Agent'}</Badge>
      </div>
      {proposal.description !== '' ? <p className="mt-1 text-sm text-text-secondary">{proposal.description}</p> : null}
      {proposal.kind === 'workflow' ? (
        <ol className="mt-2 flex flex-wrap items-center gap-1 text-xs text-text-secondary">
          {proposal.draft.manifest.nodes.map((node, index) => (
            <li key={node.id} className="flex items-center gap-1">
              {index > 0 ? <Icon name="chevron-right" className="size-3 opacity-60" /> : null}
              <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5">
                <Icon name={NODE_TYPES[node.type].icon} className="size-3" />
                {node.name}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 line-clamp-3 text-xs whitespace-pre-wrap text-text-secondary">{proposal.instructions}</p>
      )}
      {proposal.kind === 'workflow' && proposal.skippedSteps.length > 0 ? (
        <p className="mt-2 text-xs text-text-secondary">
          Not added (unknown step type): {proposal.skippedSteps.join(', ')}. Add them by hand in the editor.
        </p>
      ) : null}
      <Button type="button" size="small" className="mt-3" onClick={onOpen}>
        <Icon name={isWorkflow ? 'workflow' : 'agent-2'} className="size-3.5" />
        {isWorkflow ? 'Open in workflow editor' : 'Open in agent builder'}
      </Button>
      <p className="mt-1 text-xs text-text-secondary">Nothing is saved until you review it and click Save.</p>
    </div>
  );
}

export function HomeAdvisor({ className }: HomeAdvisorProps) {
  const server = useServer();
  const shell = useOptionalShellMode();
  const track = useTrackAnalytics();
  const [messages, setMessages] = useState<AdvisorMessage[]>([]);
  const [draftText, setDraftText] = useState('');
  const [sending, setSending] = useState(false);
  const sessionRef = useRef<{ sessionId: string; lastTurnId: string | undefined } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const modelReady = (shell?.draftSeedSpec('chat').model.name ?? '') !== '';

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    const list = listRef.current;
    if (list != null) list.scrollTop = list.scrollHeight;
  }, [messages]);

  const updateAssistant = (id: string, update: Partial<AdvisorMessage>) =>
    setMessages(current => current.map(message => (message.id === id ? { ...message, ...update } : message)));

  const send = async (question: string) => {
    const trimmed = question.trim();
    if (trimmed === '' || sending || shell == null) return;
    const replyId = `assistant-${String(Date.now())}`;
    setMessages(current => [
      ...current,
      { id: `user-${String(Date.now())}`, role: 'user', text: trimmed },
      { id: replyId, role: 'assistant', text: '' },
    ]);
    setDraftText('');
    setSending(true);
    track(AnalyticsEvents.Hub.ADVISOR_MESSAGE_SENT, { first: sessionRef.current == null });
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      if (sessionRef.current == null) {
        const session = await server.createSession({
          agentSpec: { ...shell.draftSeedSpec('chat'), instructions: ADVISOR_INSTRUCTIONS },
          title: 'Forgeflow advisor',
        });
        sessionRef.current = { sessionId: session.id, lastTurnId: undefined };
      }
      const { sessionId, lastTurnId } = sessionRef.current;
      // One entry per model message, so streamed deltas are replaced by the final text.
      const parts = new Map<string, string>();
      const render = () => updateAssistant(replyId, { text: [...parts.values()].join('\n\n') });
      const stream = server.createTurn({
        sessionId,
        input: [{ type: 'user.message', content: trimmed }],
        ...(lastTurnId === undefined ? {} : { previousTurnId: lastTurnId }),
        abortSignal: abort.signal,
      });
      for await (const { event } of stream) {
        handleEvent({ event, parts, render, replyId, sessionId });
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        updateAssistant(replyId, { text: getErrorMessage(error, 'The advisor could not answer.'), error: true });
      }
    } finally {
      setSending(false);
    }
  };

  const handleEvent = ({
    event,
    parts,
    render,
    replyId,
    sessionId,
  }: {
    event: TurnStreamingEvent;
    parts: Map<string, string>;
    render: () => void;
    replyId: string;
    sessionId: string;
  }) => {
    switch (event.type) {
      case 'turn.created':
        sessionRef.current = { sessionId, lastTurnId: event.turnId };
        return;
      case 'model.message.delta':
        if (typeof event.content === 'string' && event.content !== '') {
          parts.set(event.id, (parts.get(event.id) ?? '') + event.content);
          render();
        }
        return;
      case 'model.message': {
        const final = messageText(event.content);
        if (final !== '') {
          parts.set(event.id, final);
          render();
        }
        return;
      }
      case 'turn.done':
        if (event.state.status === 'error') updateAssistant(replyId, { text: event.state.message, error: true });
        return;
      default:
        return;
    }
  };

  const openProposal = (proposal: AdvisorProposal) => {
    if (shell == null) return;
    track(AnalyticsEvents.Hub.ADVISOR_PROPOSAL_OPENED, { kind: proposal.kind });
    if (proposal.kind === 'workflow') {
      shell.openWorkflowDraft(proposal.draft);
      return;
    }
    shell.selectLibraryAgent({
      isMutable: true,
      isCreateAgent: true,
      agentSpec: { ...shell.draftSeedSpec('agent'), instructions: proposal.instructions },
    });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send(draftText);
  };

  return (
    <section
      aria-labelledby="home-advisor-title"
      className={cn('flex flex-col rounded-lg border border-border bg-card-bg', className)}
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Icon name="welcome-sparkle" className="size-4 text-text-secondary" />
        <div className="min-w-0">
          <h2 id="home-advisor-title" className="text-sm font-semibold text-text-primary">
            Not sure what to build? Ask the advisor
          </h2>
          <p className="text-xs text-text-secondary">
            Describe what you want to automate. It recommends an agent or a workflow and drafts it for you.
          </p>
        </div>
      </div>

      {!modelReady ? (
        <div className="flex flex-wrap items-center justify-between gap-2 p-4">
          <p className="text-sm text-text-secondary">The advisor needs a model. Add one in Settings to start.</p>
          <Button.Secondary type="button" size="small" onClick={() => shell?.setSettingsOpen(true, 'models')}>
            Open Settings
          </Button.Secondary>
        </div>
      ) : (
        <>
          <div
            ref={listRef}
            aria-live="polite"
            className="flex max-h-[28rem] min-h-0 flex-col gap-3 overflow-y-auto p-4"
          >
            {messages.length === 0 ? (
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map(suggestion => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => void send(suggestion)}
                    className="rounded-full border border-border px-3 py-1 text-left text-xs text-text-secondary hover:bg-secondary-button-hover hover:text-text-primary"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : null}
            {messages.map(message => {
              if (message.role === 'user') {
                return (
                  <div
                    key={message.id}
                    className="max-w-[85%] self-end rounded-lg bg-secondary-button-hover px-3 py-2 text-sm whitespace-pre-wrap text-text-primary"
                  >
                    {message.text}
                  </div>
                );
              }
              const { text, proposal } = parseAdvisorReply(message.text);
              const streaming = sending && message === messages.at(-1);
              return (
                <div key={message.id} className="max-w-[95%] self-start text-sm text-text-primary">
                  {message.error === true ? (
                    <p role="alert" className="text-failure-bg">
                      {message.text}
                    </p>
                  ) : text === '' && streaming ? (
                    <p className="text-text-secondary">Thinking…</p>
                  ) : (
                    <Markdown content={text} isStreaming={streaming} />
                  )}
                  {proposal != null && !streaming ? (
                    <ProposalCard proposal={proposal} onOpen={() => openProposal(proposal)} />
                  ) : null}
                </div>
              );
            })}
          </div>
          <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-border p-3">
            <textarea
              aria-label="Describe what you want to automate"
              rows={2}
              value={draftText}
              placeholder="e.g. Every Monday, collect new GitHub issues and post a summary to our team channel"
              onChange={event => setDraftText(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(draftText);
                }
              }}
              className={auiInputClass('min-w-0 flex-1 resize-none py-2')}
            />
            <Button type="submit" size="large" disabled={sending || draftText.trim() === ''} aria-label="Send">
              <Icon name="arrow-up" className="size-4" />
            </Button>
          </form>
        </>
      )}
    </section>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    HomeAdvisor: ComponentType<HomeAdvisorProps>;
  }
}
