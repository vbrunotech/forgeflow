'use client';

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';

import { useTrackAnalytics } from '../../analytics/AnalyticsProvider.js';
import { AnalyticsEvents } from '../../analytics/events.js';
import { useToasterOptional } from '../../containers/ToasterContainer.js';
import { Icon } from '../../icons/Icon.js';
import { useWorkflowServer } from '../../server/ServerContext.js';
import { useOptionalShellMode, type WorkflowsSection } from '../../server/ShellModeContext.js';
import type { Workflow, WorkflowRun, WorkflowTrigger } from '../../server/types.js';
import { useSlot } from '../../theme/SlotsProvider.js';
import { EmptyScreen } from '../EmptyScreen.js';
import { cn } from '../lib/cn.js';
import { PageHeader } from '../PageHeader.js';
import { Badge, type BadgeVariant } from '../primitives/Badge.js';
import { Button } from '../primitives/Button.js';
import SearchInput from '../primitives/SearchInput.js';
import { Skeleton } from '../primitives/Skeleton.js';
import { formatCadenceSummary } from '../schedules/cadence.js';
import { WORKFLOW_TEMPLATES, type WorkflowDraft } from './workflowDraft.js';

export type WorkflowsPageProps = {
  section: WorkflowsSection;
  className?: string;
};

type EditorState = { kind: 'closed' } | { kind: 'new'; draft: WorkflowDraft } | { kind: 'edit'; workflowId: string };

/** Runs fetched per workflow for the cross-workflow Runs page. */
const RUNS_PER_WORKFLOW = 20;

const RUN_STATUS_VARIANT: Record<WorkflowRun['status'], BadgeVariant> = {
  running: 'info',
  succeeded: 'success',
  failed: 'destructive',
};

const TRIGGER_LABEL: Record<WorkflowRun['triggerType'], string> = {
  manual: 'Manual',
  cron: 'Scheduled',
  webhook: 'Webhook',
};

function triggerSummary(trigger: WorkflowTrigger): string {
  switch (trigger.type) {
    case 'manual':
      return 'Run manually';
    case 'cron':
      return formatCadenceSummary({ cron: trigger.cron, timezone: trigger.timezone });
    case 'webhook':
      return 'On webhook';
  }
}

function PageLoading() {
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1, 2].map(i => (
        <li key={i}>
          <Skeleton className="h-10 w-full" />
        </li>
      ))}
    </ul>
  );
}

function WorkflowList({ onOpen }: { onOpen: (workflowId: string) => void }) {
  const server = useWorkflowServer();
  const toaster = useToasterOptional();
  const [query, setQuery] = useState('');
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextToken, setNextToken] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    server
      .listWorkflows()
      .then(page => {
        if (cancelled) return;
        setWorkflows(page.data);
        setNextToken(page.nextPageToken);
      })
      .catch((error: unknown) => {
        if (!cancelled) toaster?.showError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [server, toaster]);

  const loadMore = async () => {
    if (nextToken === undefined) return;
    try {
      const page = await server.listWorkflows({ pageToken: nextToken });
      setWorkflows(current => [...current, ...page.data]);
      setNextToken(page.nextPageToken);
    } catch (error) {
      toaster?.showError(error);
    }
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return workflows;
    return workflows.filter(
      workflow =>
        workflow.name.toLowerCase().includes(needle) || workflow.manifest.description.toLowerCase().includes(needle),
    );
  }, [workflows, query]);

  return (
    <div className="flex flex-col gap-2">
      <SearchInput query={query} setQuery={setQuery} placeholder="Search workflows" />
      {loading ? (
        <PageLoading />
      ) : visible.length === 0 ? (
        <EmptyScreen
          title={query === '' ? 'No workflows yet' : 'No matches'}
          description={query === '' ? 'Create a workflow to get started.' : 'Try another search.'}
          className="py-10"
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {visible.map(workflow => (
            <li key={workflow.id}>
              <button
                type="button"
                onClick={() => onOpen(workflow.id)}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-secondary-button-hover"
              >
                <Icon name="workflow" className="size-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text-primary">{workflow.name}</span>
                  {workflow.manifest.description !== '' ? (
                    <span className="block truncate text-xs text-text-secondary">{workflow.manifest.description}</span>
                  ) : null}
                </span>
                <span className="hidden shrink-0 text-xs text-text-secondary md:inline">
                  {workflow.manifest.triggers.map(triggerSummary).join(' · ')}
                </span>
                {workflow.manifest.status === 'paused' ? <Badge variant="warning">Paused</Badge> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {nextToken !== undefined ? (
        <Button.Secondary type="button" size="large" className="self-center" onClick={() => void loadMore()}>
          Load more workflows
        </Button.Secondary>
      ) : null}
    </div>
  );
}

function TemplatePicker({ onPick }: { onPick: (draft: WorkflowDraft) => void }) {
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {WORKFLOW_TEMPLATES.map(template => (
        <li key={template.id}>
          <button
            type="button"
            onClick={() => onPick(template.draft)}
            className="flex h-full w-full flex-col items-start gap-1 rounded-lg border border-border bg-card-bg p-4 text-left hover:bg-secondary-button-hover"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Icon name="workflow" className="size-4" />
              {template.label}
            </span>
            <span className="text-sm text-text-secondary">{template.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

type RunRow = { run: WorkflowRun; workflowName: string };

function RunsList({ onOpen }: { onOpen: (workflowId: string) => void }) {
  const server = useWorkflowServer();
  const toaster = useToasterOptional();
  const [rows, setRows] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<RunRow[]> => {
    // The API lists runs per workflow, so merge the latest runs of each into one timeline.
    const workflows = await server.listWorkflows();
    const pages = await Promise.all(
      workflows.data.map(async workflow => {
        const page = await server.listRuns({ workflowId: workflow.id, limit: RUNS_PER_WORKFLOW });
        return page.data.map(run => ({ run, workflowName: workflow.name }));
      }),
    );
    return pages.flat().sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
  }, [server]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then(next => {
        if (!cancelled) setRows(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) toaster?.showError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, toaster]);

  if (loading) return <PageLoading />;
  if (rows.length === 0) {
    return <EmptyScreen title="No runs yet" description="Runs appear here once a workflow runs." className="py-10" />;
  }
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {rows.map(({ run, workflowName }) => (
        <li key={run.id}>
          <button
            type="button"
            onClick={() => onOpen(run.workflowId)}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-secondary-button-hover"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-text-primary">{workflowName}</span>
              <span className="block truncate text-xs text-text-secondary">
                {new Date(run.createdAt).toLocaleString()}
                {run.error != null ? ` · ${run.error}` : ''}
              </span>
            </span>
            <span className="hidden shrink-0 text-xs text-text-secondary md:inline">
              {TRIGGER_LABEL[run.triggerType]}
            </span>
            <Badge variant={RUN_STATUS_VARIANT[run.status]}>{run.status}</Badge>
          </button>
        </li>
      ))}
    </ul>
  );
}

const SECTION_TITLE: Record<WorkflowsSection, string> = {
  list: 'Workflows',
  new: 'New workflow',
  runs: 'Runs',
};

export function WorkflowsPage({ section, className }: WorkflowsPageProps) {
  const shell = useOptionalShellMode();
  const WorkflowEditor = useSlot('WorkflowEditor');
  const ImportDialog = useSlot('WorkflowImportDialog');
  const track = useTrackAnalytics();
  const [importOpen, setImportOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>({ kind: 'closed' });
  const seed = shell?.workflowDraftSeed ?? null;

  // A draft handed over from elsewhere (the Home advisor) opens straight in the editor.
  useEffect(() => {
    if (section !== 'new' || seed == null) return;
    setEditor({ kind: 'new', draft: seed });
    shell?.clearWorkflowDraftSeed();
  }, [section, seed, shell]);

  if (editor.kind !== 'closed') {
    return (
      <WorkflowEditor
        {...(editor.kind === 'edit' ? { workflowId: editor.workflowId } : { initialDraft: editor.draft })}
        onClose={() => {
          setEditor({ kind: 'closed' });
          // Leaving a fresh draft returns to the list rather than the template picker.
          if (section === 'new') shell?.setWorkflowsSection('list');
        }}
        onCreated={workflowId => setEditor({ kind: 'edit', workflowId })}
      />
    );
  }

  const openWorkflow = (workflowId: string) => setEditor({ kind: 'edit', workflowId });

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <PageHeader
        title={SECTION_TITLE[section]}
        end={
          section === 'list' || section === 'new' ? (
            <>
              <Button.Secondary type="button" size="large" onClick={() => setImportOpen(true)}>
                <Icon name="download" className="size-3.5" />
                Import
              </Button.Secondary>
              {section === 'list' ? (
                <Button type="button" size="large" onClick={() => shell?.setWorkflowsSection('new')}>
                  <Icon name="workflow" className="size-3.5" />
                  New workflow
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
          {section === 'list' ? <WorkflowList onOpen={openWorkflow} /> : null}
          {section === 'new' ? <TemplatePicker onPick={draft => setEditor({ kind: 'new', draft })} /> : null}
          {section === 'runs' ? <RunsList onOpen={openWorkflow} /> : null}
        </div>
      </div>
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        description="Opens the imported workflow as a new, unsaved draft so you can review it before saving."
        confirmLabel="Open in editor"
        onImport={result => {
          track(AnalyticsEvents.Workflow.IMPORTED, { format: result.format, via: 'workflows_page' });
          setEditor({ kind: 'new', draft: result.draft });
        }}
      />
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    WorkflowsPage: ComponentType<WorkflowsPageProps>;
  }
}
