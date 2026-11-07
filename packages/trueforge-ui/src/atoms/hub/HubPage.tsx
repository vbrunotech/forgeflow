'use client';

import { useState, type ComponentType } from 'react';

import { useTrackAnalytics } from '../../analytics/AnalyticsProvider.js';
import { AnalyticsEvents } from '../../analytics/events.js';
import { Icon } from '../../icons/Icon.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import { useSlot } from '../../theme/SlotsProvider.js';
import { cn } from '../lib/cn.js';
import { PageHeader } from '../PageHeader.js';
import { Button } from '../primitives/Button.js';
import { recommendAutomation, type ChooserAnswers } from './chooser.js';

export type HubPageProps = {
  className?: string;
};

const QUESTIONS: Array<{ key: keyof ChooserAnswers; label: string }> = [
  { key: 'stepsKnown', label: 'Can you write down every step in advance?' },
  { key: 'inputsStructured', label: 'Do inputs arrive in a predictable format?' },
  { key: 'mustBeRepeatable', label: 'Must the same input always lead to the same actions?' },
];

function Chooser({ onNewWorkflow, onNewAgent }: { onNewWorkflow: () => void; onNewAgent: () => void }) {
  const track = useTrackAnalytics();
  const [answers, setAnswers] = useState<ChooserAnswers>({
    stepsKnown: null,
    inputsStructured: null,
    mustBeRepeatable: null,
  });
  const recommendation = recommendAutomation(answers);

  const answer = (key: keyof ChooserAnswers, value: boolean) => {
    const next = { ...answers, [key]: value };
    setAnswers(next);
    const result = recommendAutomation(next);
    if (result != null) track(AnalyticsEvents.Hub.CHOOSER_ANSWERED, { recommendation: result.kind });
  };

  return (
    <section aria-labelledby="hub-chooser-title" className="rounded-lg border border-border bg-card-bg p-4">
      <h2 id="hub-chooser-title" className="text-sm font-semibold text-text-primary">
        Or answer three quick questions
      </h2>
      <ul className="mt-3 flex flex-col gap-2">
        {QUESTIONS.map(question => (
          <li key={question.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-text-secondary">{question.label}</span>
            <span role="group" aria-label={question.label} className="inline-flex gap-1">
              {[true, false].map(value => (
                <Button
                  key={String(value)}
                  type="button"
                  size="small"
                  variant={answers[question.key] === value ? 'primary' : 'secondary'}
                  aria-pressed={answers[question.key] === value}
                  onClick={() => answer(question.key, value)}
                >
                  {value ? 'Yes' : 'No'}
                </Button>
              ))}
            </span>
          </li>
        ))}
      </ul>
      {recommendation != null ? (
        <div
          role="status"
          className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">{recommendation.title}</p>
            <p className="text-sm text-text-secondary">{recommendation.reason}</p>
          </div>
          <Button type="button" size="small" onClick={recommendation.kind === 'agent' ? onNewAgent : onNewWorkflow}>
            {recommendation.kind === 'agent' ? 'Build agent' : 'New workflow'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function SpaceCards({ onOpenAgents, onOpenWorkflows }: { onOpenAgents: () => void; onOpenWorkflows: () => void }) {
  const cards = [
    {
      icon: 'agent-2' as const,
      title: 'Agents',
      lead: 'A model decides the steps.',
      points: ['Handles messy, open-ended input', 'Picks tools as it goes', 'Costs and timing vary by run'],
      fit: 'Research, triage of free text, investigating problems.',
      onOpen: onOpenAgents,
    },
    {
      icon: 'workflow' as const,
      title: 'Workflows',
      lead: 'You define the steps.',
      points: [
        'Same path every run',
        'No model cost unless you add an agent step',
        'Every step is visible and auditable',
      ],
      fit: 'Syncing data, routing webhooks, scheduled checks.',
      onOpen: onOpenWorkflows,
    },
  ];
  return (
    <section aria-label="Spaces" className="grid gap-3 md:grid-cols-2">
      {cards.map(card => (
        <button
          key={card.title}
          type="button"
          onClick={card.onOpen}
          className="flex flex-col items-start rounded-lg border border-border bg-card-bg p-5 text-left hover:bg-secondary-button-hover"
        >
          <span className="flex w-full items-center gap-2 text-base font-semibold text-text-primary">
            <Icon name={card.icon} className="size-5" />
            {card.title}
            <Icon name="chevron-right" className="ml-auto size-4 opacity-60" />
          </span>
          <span className="mt-1 text-sm text-text-primary">{card.lead}</span>
          <ul className="mt-2 list-disc pl-4 text-sm text-text-secondary">
            {card.points.map(point => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <span className="mt-2 text-xs text-text-secondary">Good for: {card.fit}</span>
        </button>
      ))}
    </section>
  );
}

export function HubPage({ className }: HubPageProps) {
  const shell = useOptionalShellMode();
  const track = useTrackAnalytics();
  const HomeAdvisor = useSlot('HomeAdvisor');

  const openAgents = () => {
    track(AnalyticsEvents.Hub.SPACE_OPENED, { space: 'agents' });
    shell?.setHubOpen(false);
  };
  const openWorkflows = () => {
    track(AnalyticsEvents.Hub.SPACE_OPENED, { space: 'workflows' });
    shell?.setWorkflowsSection('list');
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <PageHeader title="Home" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
          <HomeAdvisor />
          <SpaceCards onOpenAgents={openAgents} onOpenWorkflows={openWorkflows} />
          <Chooser
            onNewWorkflow={() => shell?.setWorkflowsSection('new')}
            onNewAgent={() => shell?.openAgentBuilder()}
          />
        </div>
      </div>
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    HubPage: ComponentType<HubPageProps>;
  }
}
