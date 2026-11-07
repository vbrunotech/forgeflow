'use client';

import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';

import { useTrackAnalytics } from '../../analytics/AnalyticsProvider.js';
import { AnalyticsEvents } from '../../analytics/events.js';
import { useToasterOptional } from '../../containers/ToasterContainer.js';
import { Icon } from '../../icons/Icon.js';
import { useWorkflowServer } from '../../server/ServerContext.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import type { WorkflowEdge, WorkflowNode, WorkflowRun, WorkflowRunStep, WorkflowTrigger } from '../../server/types.js';
import { useSlot } from '../../theme/SlotsProvider.js';
import { useTheme } from '../../theme/ThemeProvider.js';
import { getErrorMessage } from '../../utils/getErrorMessage.js';
import { replaceSessionShareSearch } from '../../utils/sessionShareUrl.js';
import { triggerBrowserDownload } from '../../utils/triggerBrowserDownload.js';
import { cn } from '../lib/cn.js';
import { auiInputClass } from '../lib/inputClasses.js';
import { PageHeader } from '../PageHeader.js';
import { Badge } from '../primitives/Badge.js';
import { Button } from '../primitives/Button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../primitives/Dialog.js';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRichItem,
  DropdownMenuSeparator,
} from '../primitives/DropdownMenu.js';
import { PopoverSelect } from '../primitives/PopoverSelect.js';
import { Skeleton } from '../primitives/Skeleton.js';
import { Switch } from '../primitives/Switch.js';
import { formatCadenceSummary } from '../schedules/cadence.js';
import {
  addStep,
  canAddTrigger,
  createTrigger,
  draftProblems,
  NODE_TYPES,
  nodeBranches,
  removeNode,
  removeSwitchRule,
  renameNodeId,
  stepStatusByNode,
  TRIGGER_TYPE_LABELS,
  wouldCreateCycle,
  type WorkflowDraft,
  type WorkflowNodeType,
  type WorkflowTriggerType,
} from './workflowDraft.js';
import { WorkflowNodeInspector } from './WorkflowNodeInspector.js';
import { WorkflowRunsPanel, WorkflowStepResult } from './WorkflowRunsPanel.js';
import {
  exportForgeflowJson,
  exportN8nJson,
  mergeImportedWorkflow,
  parseWorkflowImport,
  workflowFileName,
  type WorkflowFileFormat,
  type WorkflowImport,
} from './workflowTransfer.js';

export type WorkflowEditorProps = {
  /** Existing workflow to load. */
  workflowId?: string;
  /** Unsaved starting point for a new workflow. */
  initialDraft?: WorkflowDraft;
  onClose: () => void;
  onCreated: (workflowId: string) => void;
};

const RUN_POLL_MS = 1500;
/** Mirrors the server's limit on triggers per workflow. */
const MAX_TRIGGERS = 10;

const TRIGGER_OPTIONS: Array<{ value: WorkflowTriggerType; label: string }> = (
  ['manual', 'cron', 'webhook'] as const
).map(value => ({ value, label: TRIGGER_TYPE_LABELS[value] }));

type CanvasNodeData = {
  node: WorkflowNode;
  step: WorkflowRunStep | undefined;
  /** Opens the step picker with the new step wired after this output. */
  onAddAfter: (branch?: string) => void;
};
type TriggerNodeData = {
  trigger: WorkflowTrigger;
  /** No steps yet: keep the "+" visible so the first step is easy to add. */
  empty: boolean;
  onAddStep: () => void;
};
type StepCanvasNode = Node<CanvasNodeData, 'step'>;
type TriggerCanvasNode = Node<TriggerNodeData, 'trigger'>;
type CanvasNode = StepCanvasNode | TriggerCanvasNode;

/** Triggers are drawn as the first nodes, like n8n; they are not stored as steps. */
const TRIGGER_NODE_PREFIX = '__trigger__';

function triggerNodeId(index: number): string {
  return `${TRIGGER_NODE_PREFIX}${String(index)}`;
}

/** Index of the trigger a canvas node id points at, or null for a step. */
function triggerIndexOf(id: string | null): number | null {
  if (id == null || !id.startsWith(TRIGGER_NODE_PREFIX)) return null;
  const index = Number(id.slice(TRIGGER_NODE_PREFIX.length));
  return Number.isInteger(index) ? index : null;
}

const TRIGGER_DISPLAY: Record<WorkflowTrigger['type'], { icon: string; title: string }> = {
  manual: { icon: 'play', title: "When you click 'Execute workflow'" },
  cron: { icon: 'calendar-clock', title: 'On a schedule' },
  webhook: { icon: 'webhook', title: 'On webhook call' },
};

function triggerSubtitle(trigger: WorkflowTrigger): string {
  switch (trigger.type) {
    case 'manual':
      return 'Manual trigger';
    case 'cron':
      return formatCadenceSummary({ cron: trigger.cron, timezone: trigger.timezone });
    case 'webhook':
      return 'Webhook trigger';
  }
}

const STEP_RING: Record<WorkflowRunStep['status'], string> = {
  pending: '',
  running: 'ring-2 ring-primary-button-bg animate-pulse',
  succeeded: 'ring-2 ring-success-bg',
  failed: 'ring-2 ring-failure-bg',
  skipped: 'opacity-50',
};

function AddAfterButton({ label, top, onClick }: { label: string; top: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      style={{ top }}
      onClick={event => {
        event.stopPropagation();
        onClick();
      }}
      className="nodrag absolute -right-7 flex size-5 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card-bg text-text-secondary opacity-0 group-hover:opacity-100 hover:text-text-primary focus-visible:opacity-100"
    >
      <Icon name="plus" className="size-3" />
    </button>
  );
}

function StepNode({ data, selected }: NodeProps<StepCanvasNode>) {
  const { node, step, onAddAfter } = data;
  const branches = nodeBranches(node);
  return (
    <div
      className={cn(
        'group relative w-56 rounded-lg border border-border bg-card-bg px-3 py-2 text-left shadow-sm',
        selected && 'border-primary-button-bg',
        step != null && STEP_RING[step.status],
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <Icon name={NODE_TYPES[node.type].icon} className="size-4 shrink-0 text-text-secondary" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{node.name}</p>
          <p className="truncate text-xs text-text-secondary">{NODE_TYPES[node.type].label}</p>
        </div>
      </div>
      {branches == null ? (
        <>
          <Handle type="source" position={Position.Right} />
          <AddAfterButton label={`Add a step after ${node.name}`} top="50%" onClick={() => onAddAfter()} />
        </>
      ) : (
        <>
          {/* Branch rows give each output room for its label. */}
          <div className="mt-2 flex flex-col gap-1">
            {branches.map(branch => (
              <span key={branch.id} className="block truncate pr-2 text-right text-[0.625rem] text-text-secondary">
                {branch.label}
              </span>
            ))}
          </div>
          {branches.map((branch, index) => {
            const top = `calc(100% - ${String((branches.length - index) * 1.25)}rem + 0.35rem)`;
            return (
              <span key={branch.id}>
                <Handle id={branch.id} type="source" position={Position.Right} style={{ top }} />
                <AddAfterButton
                  label={`Add a step on ${branch.label} of ${node.name}`}
                  top={top}
                  onClick={() => onAddAfter(branch.id)}
                />
              </span>
            );
          })}
        </>
      )}
    </div>
  );
}

function TriggerNode({ data, selected }: NodeProps<TriggerCanvasNode>) {
  const { trigger, empty, onAddStep } = data;
  const display = TRIGGER_DISPLAY[trigger.type];
  return (
    <div
      className={cn(
        // Rounded left edge marks where the run starts, as in n8n.
        'group relative flex w-72 items-center gap-2 rounded-l-[2rem] rounded-r-lg border border-border bg-card-bg py-3 pr-3 pl-4 text-left shadow-sm',
        selected && 'border-primary-button-bg',
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-button-bg text-primary-button-text">
        <Icon name={display.icon} className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm leading-tight font-medium text-text-primary">{display.title}</p>
        <p className="truncate text-xs text-text-secondary">{triggerSubtitle(trigger)}</p>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <button
        type="button"
        aria-label="Add a step after the trigger"
        title="Add a step"
        onClick={event => {
          event.stopPropagation();
          onAddStep();
        }}
        className={cn(
          'nodrag absolute -right-7 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card-bg text-text-secondary hover:text-text-primary focus-visible:opacity-100',
          empty ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        <Icon name="plus" className="size-3" />
      </button>
    </div>
  );
}

const canvasNodeTypes = { step: StepNode, trigger: TriggerNode };

function edgeKey(edge: WorkflowEdge): string {
  return `${edge.source}->${edge.target}:${edge.branch ?? ''}`;
}

function TriggerPanel({
  trigger,
  otherTriggers,
  workflowId,
  webhookConfigured,
  dirty,
  onChange,
  onRemove,
}: {
  trigger: WorkflowTrigger;
  /** The workflow's other triggers, so this one cannot become a second manual or webhook trigger. */
  otherTriggers: readonly WorkflowTrigger[];
  workflowId: string | undefined;
  webhookConfigured: boolean;
  dirty: boolean;
  onChange: (trigger: WorkflowTrigger) => void;
  /** Omitted for the last remaining trigger: a workflow needs at least one. */
  onRemove?: () => void;
}) {
  const typeOptions = TRIGGER_OPTIONS.filter(
    option => option.value === trigger.type || canAddTrigger({ triggers: otherTriggers, type: option.value }),
  );
  const server = useWorkflowServer();
  const toaster = useToasterOptional();
  const track = useTrackAnalytics();
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);

  const issue = async () => {
    if (workflowId === undefined) return;
    try {
      const { url } = await server.createWebhookUrl({ workflowId });
      setWebhookUrl(url);
      track(AnalyticsEvents.Workflow.WEBHOOK_URL_ISSUED, { workflow_id: workflowId });
    } catch (error) {
      toaster?.showError(error);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-text-primary">Trigger</span>
      <PopoverSelect
        aria-label="Trigger"
        value={trigger.type}
        options={typeOptions}
        onValueChange={type => onChange(createTrigger(type))}
      />
      {trigger.type === 'cron' ? (
        <>
          <input
            aria-label="Cron expression"
            value={trigger.cron}
            onChange={event => onChange({ ...trigger, cron: event.target.value })}
            className={auiInputClass('h-8 font-mono')}
          />
          <input
            aria-label="Time zone"
            value={trigger.timezone}
            onChange={event => onChange({ ...trigger, timezone: event.target.value })}
            className={auiInputClass('h-8')}
          />
          <p className="text-xs text-text-secondary">
            {formatCadenceSummary({ cron: trigger.cron, timezone: trigger.timezone })}
          </p>
        </>
      ) : null}
      {trigger.type === 'webhook' ? (
        <>
          {webhookUrl != null ? (
            <>
              <input aria-label="Webhook URL" readOnly value={webhookUrl} className={auiInputClass('h-8 font-mono')} />
              <p className="text-xs text-text-secondary">Copy this now. It is not shown again.</p>
            </>
          ) : (
            <Button.Secondary
              type="button"
              size="small"
              disabled={workflowId === undefined || dirty}
              onClick={() => void issue()}
            >
              {webhookConfigured ? 'Replace webhook URL' : 'Create webhook URL'}
            </Button.Secondary>
          )}
          {workflowId === undefined || dirty ? (
            <p className="text-xs text-text-secondary">Save first to create the URL.</p>
          ) : null}
          {webhookConfigured && webhookUrl == null ? (
            <p className="text-xs text-text-secondary">Replacing it stops the current URL working.</p>
          ) : null}
        </>
      ) : null}
      {onRemove != null ? (
        <Button.Secondary type="button" size="small" className="mt-2 self-start" onClick={onRemove}>
          Remove trigger
        </Button.Secondary>
      ) : null}
    </div>
  );
}

export function WorkflowEditor({ workflowId, initialDraft, onClose, onCreated }: WorkflowEditorProps) {
  const server = useWorkflowServer();
  const shell = useOptionalShellMode();
  const toaster = useToasterOptional();
  const track = useTrackAnalytics();
  const { mode: themeMode } = useTheme();

  const [draft, setDraft] = useState<WorkflowDraft | null>(initialDraft ?? null);
  const [saved, setSaved] = useState<string | null>(null);
  const [webhookConfigured, setWebhookConfigured] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [panel, setPanel] = useState<'step' | 'runs' | 'add'>('step');
  const [addAfter, setAddAfter] = useState<{ source: string; branch?: string } | undefined>(undefined);
  const NodePicker = useSlot('WorkflowNodePicker');
  const ImportDialog = useSlot('WorkflowImportDialog');
  const [importOpen, setImportOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const [starting, setStarting] = useState(false);
  // The manifest stores layout only; the canvas owns measurement and edge selection, but as a
  // controlled component it needs them handed back or nodes stay hidden and edges unselectable.
  const [measured, setMeasured] = useState<ReadonlyMap<string, { width: number; height: number }>>(new Map());
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (workflowId === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const [workflow, page] = await Promise.all([
          server.getWorkflow({ workflowId }),
          server.listRuns({ workflowId, limit: 10 }),
        ]);
        if (cancelled) return;
        const loaded = { name: workflow.name, manifest: workflow.manifest };
        setDraft(loaded);
        setSaved(JSON.stringify(loaded));
        setWebhookConfigured(workflow.webhookConfigured);
        // Executing a new workflow saves it first, which reloads it here while the run starts;
        // keep a run that is already showing instead of replacing it with an older list.
        setRuns(current => [...current, ...page.data.filter(run => !current.some(existing => existing.id === run.id))]);
        setSelectedRun(current => current ?? page.data[0] ?? null);
      } catch (error) {
        if (!cancelled) setLoadError(getErrorMessage(error, 'Could not load this workflow.'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [server, workflowId]);

  const activeRunId = selectedRun?.status === 'running' ? selectedRun.id : null;
  useEffect(() => {
    if (activeRunId == null || workflowId === undefined) return;
    const timer = setInterval(() => {
      void server
        .getRun({ workflowId, runId: activeRunId })
        .then(run => {
          setSelectedRun(current => (current?.id === run.id ? run : current));
          setRuns(current => current.map(existing => (existing.id === run.id ? run : existing)));
        })
        .catch(() => undefined);
    }, RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [activeRunId, server, workflowId]);

  const dirty = draft != null && JSON.stringify(draft) !== saved;
  const runInProgress = selectedRun?.status === 'running';
  const steps = useMemo(() => stepStatusByNode(selectedRun?.steps), [selectedRun]);

  // Steps nothing points at start the run, so the trigger connects to them.
  const rootIds = useMemo(() => {
    const targets = new Set((draft?.manifest.edges ?? []).map(edge => edge.target));
    return (draft?.manifest.nodes ?? []).filter(node => !targets.has(node.id)).map(node => node.id);
  }, [draft]);

  // Triggers stack in a column left of the steps, centred on the first step.
  const triggerNodes = useMemo<CanvasNode[]>(() => {
    if (draft == null) return [];
    const { nodes, triggers } = draft.manifest;
    const firstRoot = nodes.find(node => node.id === rootIds[0]);
    const minX = nodes.reduce((min, node) => Math.min(min, node.position.x), nodes[0]?.position.x ?? 80);
    const centerY = firstRoot?.position.y ?? 120;
    return triggers.map((trigger, index) => {
      const id = triggerNodeId(index);
      return {
        id,
        type: 'trigger',
        position: { x: minX - 360, y: centerY + (index - (triggers.length - 1) / 2) * 110 },
        draggable: false,
        deletable: false,
        selected: selectedNodeId === id,
        ...(measured.has(id) ? { measured: measured.get(id) } : {}),
        data: {
          trigger,
          empty: nodes.length === 0 && index === 0,
          onAddStep: () => {
            setAddAfter(undefined);
            setPanel('add');
          },
        },
      };
    });
  }, [draft, measured, rootIds, selectedNodeId]);

  const stepNodes = useMemo<CanvasNode[]>(
    () =>
      (draft?.manifest.nodes ?? []).map(node => ({
        id: node.id,
        type: 'step',
        position: node.position,
        selected: node.id === selectedNodeId,
        ...(measured.has(node.id) ? { measured: measured.get(node.id) } : {}),
        data: {
          node,
          step: steps.get(node.id),
          onAddAfter: (branch?: string) => {
            setAddAfter({ source: node.id, ...(branch === undefined ? {} : { branch }) });
            setPanel('add');
          },
        },
      })),
    [draft, measured, selectedNodeId, steps],
  );

  const canvasNodes = useMemo(() => [...triggerNodes, ...stepNodes], [stepNodes, triggerNodes]);

  const canvasEdges = useMemo<Edge[]>(
    () => [
      ...triggerNodes.flatMap(trigger =>
        rootIds.map(id => ({
          id: `${trigger.id}->${id}`,
          source: trigger.id,
          target: id,
          deletable: false,
          selectable: false,
        })),
      ),
      ...(draft?.manifest.edges ?? []).map(edge => ({
        id: edgeKey(edge),
        source: edge.source,
        target: edge.target,
        selected: selectedEdgeIds.has(edgeKey(edge)),
        ...(edge.branch === undefined ? {} : { sourceHandle: edge.branch, label: edge.branch }),
      })),
    ],
    [draft, rootIds, selectedEdgeIds, triggerNodes],
  );

  const updateManifest = useCallback((update: (manifest: WorkflowDraft['manifest']) => WorkflowDraft['manifest']) => {
    setDraft(current => (current == null ? current : { ...current, manifest: update(current.manifest) }));
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const sized = changes.flatMap(change =>
        change.type === 'dimensions' && change.dimensions !== undefined
          ? [{ id: change.id, dimensions: change.dimensions }]
          : [],
      );
      if (sized.length > 0) {
        setMeasured(current => {
          const next = new Map(current);
          for (const { id, dimensions } of sized) next.set(id, dimensions);
          return next;
        });
      }
      const moved = changes.some(change => change.type === 'position' && triggerIndexOf(change.id) == null);
      if (!moved) return;
      updateManifest(manifest => {
        const positioned = applyNodeChanges(
          changes,
          manifest.nodes.map(node => ({ id: node.id, position: node.position, data: {} })),
        );
        const byId = new Map(positioned.map(node => [node.id, node.position]));
        return {
          ...manifest,
          nodes: manifest.nodes.map(node => ({ ...node, position: byId.get(node.id) ?? node.position })),
        };
      });
    },
    [updateManifest],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setSelectedEdgeIds(current => {
      const next = new Set(current);
      for (const change of changes) {
        if (change.type === 'select') {
          if (change.selected) next.add(change.id);
          else next.delete(change.id);
        }
      }
      return next;
    });
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      const { source, target, sourceHandle } = connection;
      // Trigger links are drawn from the graph, never stored.
      if (triggerIndexOf(source) != null || triggerIndexOf(target) != null) return;
      updateManifest(manifest => {
        if (wouldCreateCycle({ edges: manifest.edges, source, target })) {
          toaster?.showError(new Error('That connection would create a loop. Workflows cannot loop.'));
          return manifest;
        }
        const edge: WorkflowEdge = { source, target, ...(sourceHandle == null ? {} : { branch: sourceHandle }) };
        if (manifest.edges.some(existing => edgeKey(existing) === edgeKey(edge))) return manifest;
        return { ...manifest, edges: [...manifest.edges, edge] };
      });
    },
    [toaster, updateManifest],
  );

  const openPicker = () => {
    setAddAfter(undefined);
    setPanel('add');
  };

  const addNode = (type: WorkflowNodeType) => {
    if (draft == null) return;
    const added = addStep({ manifest: draft.manifest, type, ...(addAfter === undefined ? {} : { after: addAfter }) });
    updateManifest(() => added.manifest);
    setSelectedNodeId(added.id);
    setAddAfter(undefined);
    setPanel('step');
  };

  const applyImport = useCallback(
    (result: WorkflowImport, via: 'dialog' | 'paste') => {
      if (draft == null) return;
      const merged = mergeImportedWorkflow({ manifest: draft.manifest, imported: result.draft.manifest });
      updateManifest(() => merged.manifest);
      track(AnalyticsEvents.Workflow.IMPORTED, { format: result.format, via });
      toaster?.showSuccess({
        title: `Added ${String(merged.addedSteps)} step${merged.addedSteps === 1 ? '' : 's'} from ${result.format === 'n8n' ? 'n8n' : 'Forgeflow'}`,
        ...(result.warnings.length > 0
          ? { description: `${String(result.warnings.length)} to check: ${result.warnings[0] ?? ''}` }
          : {}),
      });
    },
    [draft, toaster, track, updateManifest],
  );

  // Pasting workflow JSON anywhere on the editor adds it to the canvas, as in n8n.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const pasted = event.clipboardData?.getData('text/plain').trim() ?? '';
      if (!pasted.startsWith('{') && !pasted.startsWith('[')) return;
      let result: WorkflowImport;
      try {
        result = parseWorkflowImport(pasted);
      } catch {
        // Not workflow JSON: let the paste through untouched.
        return;
      }
      event.preventDefault();
      applyImport(result, 'paste');
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [applyImport]);

  const exportWorkflow = ({ format, how }: { format: WorkflowFileFormat; how: 'download' | 'copy' }) => {
    if (draft == null) return;
    const content = format === 'n8n' ? exportN8nJson(draft) : exportForgeflowJson(draft);
    track(AnalyticsEvents.Workflow.EXPORTED, { format, how });
    if (how === 'download') {
      triggerBrowserDownload(
        new Blob([content], { type: 'application/json' }),
        workflowFileName({ name: draft.name, format }),
      );
      return;
    }
    void navigator.clipboard
      .writeText(content)
      .then(() =>
        toaster?.showSuccess({
          title: format === 'n8n' ? 'Copied for n8n' : 'Copied',
          description: format === 'n8n' ? 'Paste it onto an n8n canvas.' : 'Paste it into another Forgeflow workflow.',
        }),
      )
      .catch((error: unknown) => toaster?.showError(error));
  };

  const persist = async (): Promise<string | null> => {
    if (draft == null) return null;
    const problems = draftProblems(draft);
    if (problems.length > 0) {
      toaster?.showError(new Error(problems.join(' ')));
      return null;
    }
    setSaving(true);
    try {
      if (workflowId === undefined) {
        const created = await server.createWorkflow(draft);
        track(AnalyticsEvents.Workflow.CREATED, { workflow_id: created.id });
        setSaved(JSON.stringify(draft));
        onCreated(created.id);
        return created.id;
      }
      await server.updateWorkflow({ ...draft, workflowId });
      track(AnalyticsEvents.Workflow.EDITED, { workflow_id: workflowId });
      setSaved(JSON.stringify(draft));
      return workflowId;
    } catch (error) {
      toaster?.showError(error);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const run = async (input: Record<string, unknown>) => {
    setStarting(true);
    try {
      // Runs use the stored version, so a run started with unsaved edits must save them first.
      const id = dirty || workflowId === undefined ? await persist() : workflowId;
      if (id == null) return;
      const started = await server.runWorkflow({ workflowId: id, input });
      track(AnalyticsEvents.Workflow.RUN_NOW, { workflow_id: id });
      setRuns(current => [started, ...current].slice(0, 10));
      setSelectedRun(started);
    } catch (error) {
      toaster?.showError(error);
    } finally {
      setStarting(false);
    }
  };

  const remove = async () => {
    if (workflowId === undefined) return;
    try {
      await server.deleteWorkflow({ workflowId });
      track(AnalyticsEvents.Workflow.DELETED, { workflow_id: workflowId });
      onClose();
    } catch (error) {
      toaster?.showError(error);
    }
  };

  const openSession = (sessionId: string) => {
    if (shell == null) return;
    track(AnalyticsEvents.Workflow.RUN_SESSION_OPENED, workflowId === undefined ? {} : { workflow_id: workflowId });
    replaceSessionShareSearch({ sessionId, view: 'sessions' });
    shell.setSessionsOpen(true);
  };

  const backButton = (
    <Button.Secondary type="button" size="large" aria-label="Back" onClick={onClose}>
      <Icon name="arrow-left" className="size-3.5" />
      Back
    </Button.Secondary>
  );

  if (loadError != null) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Workflow" start={backButton} />
        <p role="alert" className="p-4 text-sm text-failure-bg">
          {loadError}
        </p>
      </div>
    );
  }
  if (draft == null) {
    return (
      <div className="flex h-full flex-col" role="status" aria-busy="true">
        <PageHeader title="Workflow" start={backButton} />
        <div className="p-4">
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const selectedNode = draft.manifest.nodes.find(node => node.id === selectedNodeId);
  const selectedStep = selectedNode == null ? undefined : steps.get(selectedNode.id);
  const selectedTriggerIndex = triggerIndexOf(selectedNodeId);
  const selectedTrigger = selectedTriggerIndex == null ? undefined : draft.manifest.triggers[selectedTriggerIndex];
  const addTrigger = (type: WorkflowTrigger['type']) => {
    const index = draft.manifest.triggers.length;
    updateManifest(manifest => ({ ...manifest, triggers: [...manifest.triggers, createTrigger(type)] }));
    setSelectedNodeId(triggerNodeId(index));
    setPanel('step');
  };
  const paused = draft.manifest.status === 'paused';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        start={backButton}
        title={
          <input
            aria-label="Workflow name"
            value={draft.name}
            onChange={event => setDraft({ ...draft, name: event.target.value })}
            className={auiInputClass('h-8 w-64 font-medium')}
          />
        }
        end={
          <>
            {dirty ? <Badge variant="outline">Unsaved</Badge> : null}
            <label className="inline-flex items-center gap-2 text-sm text-text-secondary">
              Active
              <Switch
                aria-label="Workflow active"
                checked={!paused}
                onCheckedChange={checked =>
                  updateManifest(manifest => ({ ...manifest, status: checked ? 'active' : 'paused' }))
                }
              />
            </label>
            <DropdownMenu
              align="end"
              className="w-80 p-1.5"
              trigger={
                <Button.Secondary type="button" size="large">
                  <Icon name="download" className="size-3.5" />
                  Import / Export
                  <Icon name="chevron-down" className="size-3.5 opacity-60" />
                </Button.Secondary>
              }
            >
              <DropdownMenuLabel>Export</DropdownMenuLabel>
              <DropdownMenuRichItem
                icon={<Icon name="download" className="size-3.5" />}
                title="Download JSON"
                description="Forgeflow format, an exact copy"
                onClick={() => exportWorkflow({ format: 'forgeflow', how: 'download' })}
              />
              <DropdownMenuRichItem
                icon={<Icon name="download" className="size-3.5" />}
                title="Download for n8n"
                description="A file you can import into n8n"
                onClick={() => exportWorkflow({ format: 'n8n', how: 'download' })}
              />
              <DropdownMenuRichItem
                icon={<Icon name="copy" className="size-3.5" />}
                title="Copy JSON"
                description="Paste into another Forgeflow workflow"
                onClick={() => exportWorkflow({ format: 'forgeflow', how: 'copy' })}
              />
              <DropdownMenuRichItem
                icon={<Icon name="copy" className="size-3.5" />}
                title="Copy for n8n"
                description="Paste straight onto an n8n canvas"
                onClick={() => exportWorkflow({ format: 'n8n', how: 'copy' })}
              />
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Import</DropdownMenuLabel>
              <DropdownMenuRichItem
                icon={<Icon name="plus" className="size-3.5" />}
                title="Import from file or JSON…"
                description="Add steps from a Forgeflow or n8n workflow"
                onClick={() => setImportOpen(true)}
              />
              <p className="px-2 pt-1 pb-1.5 text-xs text-text-secondary">
                Tip: you can also paste workflow JSON onto the canvas.
              </p>
            </DropdownMenu>
            {workflowId !== undefined ? (
              <Button.Secondary type="button" size="large" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button.Secondary>
            ) : null}
            <Button type="button" size="large" disabled={saving || !dirty} onClick={() => void persist()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1" data-testid="workflow-canvas">
          <div className="absolute top-3 left-3 z-10 flex gap-2">
            <Button.Secondary type="button" size="large" aria-label="Add a step" onClick={openPicker}>
              <Icon name="plus" className="size-3.5" />
              Add step
            </Button.Secondary>
            <DropdownMenu
              trigger={
                <Button.Secondary type="button" size="large" disabled={draft.manifest.triggers.length >= MAX_TRIGGERS}>
                  <Icon name="play" className="size-3.5" />
                  Add trigger
                </Button.Secondary>
              }
            >
              {TRIGGER_OPTIONS.map(option => (
                <DropdownMenuItem
                  key={option.value}
                  disabled={!canAddTrigger({ triggers: draft.manifest.triggers, type: option.value })}
                  onClick={() => addTrigger(option.value)}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenu>
          </div>
          <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2">
            <Button
              type="button"
              size="large"
              disabled={draft.manifest.nodes.length === 0 || starting || saving || runInProgress}
              onClick={() => void run({})}
            >
              <Icon name="play" className="size-3.5" />
              {starting || runInProgress ? 'Running…' : 'Execute workflow'}
            </Button>
            <Button.Secondary
              type="button"
              size="large"
              disabled={draft.manifest.nodes.length === 0}
              onClick={() => setPanel('runs')}
            >
              Run with input…
            </Button.Secondary>
            {selectedRun != null && selectedRun.status !== 'running' ? (
              <button
                type="button"
                onClick={() => setPanel('runs')}
                className={cn(
                  'max-w-72 truncate rounded-full border px-3 py-1 text-xs',
                  selectedRun.status === 'succeeded'
                    ? 'border-success-bg text-success-bg'
                    : 'border-failure-bg text-failure-bg',
                )}
              >
                {selectedRun.status === 'succeeded'
                  ? 'Last run succeeded'
                  : `Last run failed: ${selectedRun.error ?? 'see Runs'}`}
              </button>
            ) : null}
          </div>
          {draft.manifest.nodes.length === 0 ? (
            <p className="pointer-events-none absolute inset-x-0 top-16 z-10 text-center text-sm text-text-secondary">
              Click the + next to a trigger to add your first step.
            </p>
          ) : null}
          <ReactFlow<CanvasNode>
            nodes={canvasNodes}
            edges={canvasEdges}
            nodeTypes={canvasNodeTypes}
            colorMode={themeMode}
            fitView
            fitViewOptions={{ maxZoom: 1 }}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_event, node) => {
              setSelectedNodeId(node.id);
              setPanel('step');
            }}
            onBeforeDelete={async ({ nodes, edges }) => ({
              nodes: nodes.filter(node => triggerIndexOf(node.id) == null),
              edges: edges.filter(edge => triggerIndexOf(edge.source) == null),
            })}
            onPaneClick={() => setSelectedNodeId(null)}
            onEdgesDelete={deleted => {
              const ids = new Set(deleted.map(edge => edge.id));
              updateManifest(manifest => ({
                ...manifest,
                edges: manifest.edges.filter(edge => !ids.has(edgeKey(edge))),
              }));
            }}
            onNodesDelete={deleted => {
              updateManifest(manifest =>
                deleted.reduce((next, node) => removeNode({ manifest: next, nodeId: node.id }), manifest),
              );
              setSelectedNodeId(null);
            }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <aside aria-label="Details" className="flex w-96 shrink-0 flex-col border-l border-border">
          <div role="tablist" aria-label="Details" className="flex border-b border-border">
            {(['step', 'runs'] as const).map(tab => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={panel === tab}
                onClick={() => setPanel(tab)}
                className={cn(
                  'flex-1 border-b-2 border-transparent px-3 py-2 text-sm text-text-secondary',
                  panel === tab && 'border-primary-button-bg font-medium text-text-primary',
                )}
              >
                {tab === 'step' ? 'Step' : 'Runs'}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {panel === 'add' ? (
              <NodePicker
                onPick={addNode}
                onClose={() => {
                  setAddAfter(undefined);
                  setPanel('step');
                }}
              />
            ) : panel === 'runs' ? (
              <WorkflowRunsPanel
                runs={runs}
                selectedRun={selectedRun}
                running={starting || saving}
                onRun={input => void run(input)}
                onSelectRun={setSelectedRun}
                onOpenSession={openSession}
              />
            ) : selectedTrigger != null && selectedTriggerIndex != null ? (
              <div className="flex flex-col gap-4 p-4">
                <p className="text-xs font-medium tracking-wide text-text-secondary uppercase">
                  Trigger{' '}
                  {draft.manifest.triggers.length > 1
                    ? `${String(selectedTriggerIndex + 1)} of ${String(draft.manifest.triggers.length)}`
                    : ''}
                </p>
                <TriggerPanel
                  key={selectedTriggerIndex}
                  trigger={selectedTrigger}
                  otherTriggers={draft.manifest.triggers.filter((_trigger, index) => index !== selectedTriggerIndex)}
                  workflowId={workflowId}
                  webhookConfigured={webhookConfigured}
                  dirty={dirty}
                  onChange={trigger =>
                    updateManifest(manifest => ({
                      ...manifest,
                      triggers: manifest.triggers.map((existing, index) =>
                        index === selectedTriggerIndex ? trigger : existing,
                      ),
                    }))
                  }
                  {...(draft.manifest.triggers.length > 1
                    ? {
                        onRemove: () => {
                          updateManifest(manifest => ({
                            ...manifest,
                            triggers: manifest.triggers.filter((_trigger, index) => index !== selectedTriggerIndex),
                          }));
                          setSelectedNodeId(null);
                        },
                      }
                    : {})}
                />
                <p className="text-xs text-text-secondary">
                  Any trigger starts the same steps. Add more with <strong>Add trigger</strong>: several schedules, plus
                  one manual and one webhook trigger.
                </p>
                <p className="text-xs text-text-secondary">
                  Whatever the trigger, <strong>Execute workflow</strong> runs it now so you can test it.
                </p>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-text-primary">Workflow description</span>
                  <textarea
                    rows={3}
                    value={draft.manifest.description}
                    onChange={event => updateManifest(manifest => ({ ...manifest, description: event.target.value }))}
                    className={auiInputClass('resize-y py-2')}
                  />
                </label>
              </div>
            ) : selectedNode != null ? (
              <>
                {selectedStep != null ? (
                  <section aria-label="Last run output" className="border-b border-border px-4 pt-3 pb-1">
                    <h3 className="text-xs font-medium tracking-wide text-text-secondary uppercase">Last run</h3>
                    <ul>
                      <WorkflowStepResult
                        step={selectedStep}
                        name={selectedNode.name}
                        onOpenSession={openSession}
                        outputOpen
                      />
                    </ul>
                  </section>
                ) : null}
                <WorkflowNodeInspector
                  key={selectedNode.id}
                  node={selectedNode}
                  onChange={node =>
                    updateManifest(manifest => ({
                      ...manifest,
                      nodes: manifest.nodes.map(existing => (existing.id === node.id ? node : existing)),
                    }))
                  }
                  onRename={id => {
                    if (draft.manifest.nodes.some(node => node.id === id)) {
                      toaster?.showError(new Error(`A step with id ${id} already exists.`));
                      return;
                    }
                    updateManifest(manifest => renameNodeId({ manifest, from: selectedNode.id, to: id }));
                    setSelectedNodeId(id);
                  }}
                  onRemoveSwitchRule={index =>
                    updateManifest(manifest => removeSwitchRule({ manifest, nodeId: selectedNode.id, index }))
                  }
                  onDelete={() => {
                    updateManifest(manifest => removeNode({ manifest, nodeId: selectedNode.id }));
                    setSelectedNodeId(null);
                  }}
                />
              </>
            ) : (
              <p className="p-4 text-sm text-text-secondary">
                Click the trigger to choose how the workflow starts, or a step to edit it. Drag between handles to
                connect steps; select a line and press Backspace to remove it. After a run, click a step to see its
                output.
              </p>
            )}
          </div>
        </aside>
      </div>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        description="Adds the imported steps and triggers to this workflow. You can also paste workflow JSON straight onto the canvas."
        confirmLabel="Add to workflow"
        onImport={result => applyImport(result, 'dialog')}
      />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this workflow?</DialogTitle>
          </DialogHeader>
          <p className="px-5 text-sm text-text-secondary">
            “{draft.name}” and its run history will be permanently deleted. This cannot be undone.
          </p>
          <DialogFooter>
            <Button.Secondary type="button" size="large" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button.Secondary>
            <Button type="button" size="large" onClick={() => void remove()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    WorkflowEditor: ComponentType<WorkflowEditorProps>;
  }
}
