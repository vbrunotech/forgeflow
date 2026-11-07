'use client';

import { useState } from 'react';

import type { WorkflowRun, WorkflowRunStep } from '../../server/types.js';
import { auiInputClass } from '../lib/inputClasses.js';
import { Badge, type BadgeVariant } from '../primitives/Badge.js';
import { Button } from '../primitives/Button.js';

const STATUS_VARIANT: Record<WorkflowRun['status'] | WorkflowRunStep['status'], BadgeVariant> = {
  running: 'info',
  succeeded: 'success',
  failed: 'destructive',
  pending: 'outline',
  skipped: 'outline',
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function parseInput(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value));
    }
    return null;
  } catch {
    return null;
  }
}

/** One step's status, error, agent session link, and output from a run. */
export function WorkflowStepResult({
  step,
  name,
  onOpenSession,
  outputOpen = false,
}: {
  step: WorkflowRunStep;
  name: string;
  onOpenSession: (sessionId: string) => void;
  /** Start with the output expanded, e.g. when it is the only result shown. */
  outputOpen?: boolean;
}) {
  const hasOutput = step.output !== null && step.output !== undefined;
  return (
    <li className="flex flex-col gap-1.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-text-primary">{name}</span>
        <Badge variant={STATUS_VARIANT[step.status]}>{step.status}</Badge>
      </div>
      {step.error != null ? <p className="text-xs text-failure-bg">{step.error}</p> : null}
      {step.sessionId != null ? (
        <button
          type="button"
          className="self-start text-xs text-primary-button-bg underline"
          onClick={() => onOpenSession(step.sessionId ?? '')}
        >
          Open agent session
        </button>
      ) : null}
      {hasOutput ? (
        <details open={outputOpen}>
          <summary className="cursor-pointer text-xs text-text-secondary">Output</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-secondary-button-hover p-2 text-xs break-words whitespace-pre-wrap">
            {JSON.stringify(step.output, null, 2)}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

export function WorkflowRunsPanel({
  runs,
  selectedRun,
  running,
  onRun,
  onSelectRun,
  onOpenSession,
}: {
  runs: readonly WorkflowRun[];
  selectedRun: WorkflowRun | null;
  running: boolean;
  onRun: (input: Record<string, unknown>) => void;
  onSelectRun: (run: WorkflowRun) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [inputText, setInputText] = useState('');
  const parsedInput = parseInput(inputText);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-text-primary">Test input (JSON)</span>
          <textarea
            rows={3}
            value={inputText}
            placeholder='{"name": "Ada"}'
            onChange={event => setInputText(event.target.value)}
            className={auiInputClass('resize-y py-2 font-mono')}
          />
        </label>
        <p className="mt-1 text-xs text-text-secondary">
          {parsedInput == null ? 'Enter a JSON object.' : 'Steps read this as {{ trigger.body }}.'}
        </p>
        <Button
          type="button"
          size="large"
          className="mt-2 w-full"
          disabled={running || parsedInput == null}
          onClick={() => {
            if (parsedInput != null) onRun(parsedInput);
          }}
        >
          {running ? 'Running…' : 'Run now'}
        </Button>
      </div>

      {selectedRun != null ? (
        <section aria-label="Selected run">
          <h3 className="text-sm font-semibold text-text-primary">Steps</h3>
          {selectedRun.error != null ? <p className="mt-1 text-xs text-failure-bg">{selectedRun.error}</p> : null}
          <ul className="divide-y divide-border">
            {selectedRun.steps.map(step => (
              <WorkflowStepResult
                key={step.nodeId}
                step={step}
                name={selectedRun.manifest.nodes.find(node => node.id === step.nodeId)?.name ?? step.nodeId}
                onOpenSession={onOpenSession}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Run history">
        <h3 className="text-sm font-semibold text-text-primary">History</h3>
        {runs.length === 0 ? <p className="mt-1 text-xs text-text-secondary">No runs yet.</p> : null}
        <ul className="mt-1 flex flex-col">
          {runs.map(run => (
            <li key={run.id}>
              <button
                type="button"
                aria-current={selectedRun?.id === run.id ? 'true' : undefined}
                onClick={() => onSelectRun(run)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-secondary-button-hover aria-[current=true]:bg-secondary-button-hover"
              >
                <span className="min-w-0 truncate text-text-secondary">
                  {formatTime(run.createdAt)} · {run.triggerType}
                </span>
                <Badge variant={STATUS_VARIANT[run.status]}>{run.status}</Badge>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
