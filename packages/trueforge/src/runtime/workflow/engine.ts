import type {
  WorkflowAgentNode,
  WorkflowEdge,
  WorkflowHttpRequestNode,
  WorkflowManifest,
  WorkflowNode,
  WorkflowRunStatus,
  WorkflowRunStep,
  WorkflowWaitNode,
} from '../../schemas/workflow';
import {
  aggregateItems,
  compareValues,
  computeCrypto,
  computeDateTime,
  filterItems,
  limitItems,
  removeDuplicateItems,
  requireList,
  sortItems,
  splitOutItems,
} from './dataSteps';
import { validateWorkflowGraph } from './graph';
import { WorkflowStepError } from './stepError';
import { renderTemplate, resolveTemplateValue, type WorkflowTemplateContext } from './template';

/** Outputs are stored on the run row, which is rewritten after every step. */
export const WORKFLOW_MAX_STEP_OUTPUT_BYTES = 256 * 1024;

export interface WorkflowStepResult {
  output: unknown;
  session_id?: string;
}

/** Steps with side effects are injected so the engine stays deterministic and testable. */
export interface WorkflowStepHandlers {
  http_request: (input: {
    node: WorkflowHttpRequestNode;
    context: WorkflowTemplateContext;
    signal: AbortSignal;
  }) => Promise<WorkflowStepResult>;
  agent: (input: {
    node: WorkflowAgentNode;
    context: WorkflowTemplateContext;
    signal: AbortSignal;
    onSession: (sessionId: string) => Promise<void>;
  }) => Promise<WorkflowStepResult>;
  wait: (input: { node: WorkflowWaitNode; signal: AbortSignal }) => Promise<WorkflowStepResult>;
}

/** Resolves after `seconds`, or rejects as soon as the run is cancelled or times out. */
export function waitStep({
  node,
  signal,
}: {
  node: WorkflowWaitNode;
  signal: AbortSignal;
}): Promise<WorkflowStepResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new WorkflowStepError('Wait cancelled'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new WorkflowStepError('Wait cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve({ output: { waited_seconds: node.seconds } });
    }, node.seconds * 1000);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface WorkflowExecutionResult {
  status: Exclude<WorkflowRunStatus, 'running'>;
  steps: WorkflowRunStep[];
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : 'Step failed';
}

export function capStepOutput(output: unknown): unknown {
  const serialized = JSON.stringify(output ?? null);
  if (Buffer.byteLength(serialized) <= WORKFLOW_MAX_STEP_OUTPUT_BYTES) {
    return output ?? null;
  }
  return { truncated: true, preview: serialized.slice(0, 4096) };
}

/** An edge carries flow when its source ran and, for a condition or switch, took that branch. */
function edgeIsActive({
  edge,
  stepsById,
  branchTaken,
}: {
  edge: WorkflowEdge;
  stepsById: ReadonlyMap<string, WorkflowRunStep>;
  branchTaken: ReadonlyMap<string, string>;
}): boolean {
  const status = stepsById.get(edge.source)?.status;
  if (status !== 'succeeded' && status !== 'failed') {
    return false;
  }
  return edge.branch === undefined || branchTaken.get(edge.source) === edge.branch;
}

/**
 * Runs nodes one at a time in topological order. A node with several incoming edges runs
 * once if any of them is active; roots always run. Sequential by design: step order, and
 * therefore a run's side effects, are reproducible from the manifest.
 */
export async function executeWorkflow(params: {
  manifest: Pick<WorkflowManifest, 'nodes' | 'edges'>;
  trigger: Record<string, unknown>;
  handlers: WorkflowStepHandlers;
  signal: AbortSignal;
  /** Persist progress. Called with a fresh snapshot after every state change. */
  onProgress: (steps: WorkflowRunStep[]) => Promise<void>;
}): Promise<WorkflowExecutionResult> {
  const { manifest, trigger, handlers, signal, onProgress } = params;
  const ordered = validateWorkflowGraph(manifest);
  const steps: WorkflowRunStep[] = ordered.map(node => ({
    node_id: node.id,
    status: 'pending',
    output: null,
    error: null,
    session_id: null,
    started_at: null,
    finished_at: null,
  }));
  const stepsById = new Map(steps.map(step => [step.node_id, step]));
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const edge of manifest.edges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
  }
  const branchTaken = new Map<string, string>();
  const context: WorkflowTemplateContext = { trigger, nodes: {} };
  const progress = () => onProgress(steps.map(step => ({ ...step })));

  // Outputs of the steps that actually fed this one, in edge order.
  const upstreamOutputs = (nodeId: string): unknown[] =>
    (incoming.get(nodeId) ?? [])
      .filter(edge => edgeIsActive({ edge, stepsById, branchTaken }))
      .map(edge => context.nodes[edge.source]?.output ?? null);
  // What "the previous step" means: its output, or every output when several branches meet.
  const upstreamOutput = (nodeId: string): unknown => {
    const outputs = upstreamOutputs(nodeId);
    if (outputs.length === 0) {
      return trigger;
    }
    return outputs.length === 1 ? outputs[0] : outputs;
  };
  const listInput = (node: WorkflowNode & { input: string }): unknown[] =>
    requireList(
      node.input.trim() === '' ? upstreamOutput(node.id) : resolveTemplateValue({ template: node.input, context }),
    );

  const runNode = async (node: WorkflowNode, step: WorkflowRunStep): Promise<WorkflowStepResult> => {
    switch (node.type) {
      case 'transform':
        return {
          output: Object.fromEntries(
            Object.entries(node.values).map(([key, template]) => [key, resolveTemplateValue({ template, context })]),
          ),
        };
      case 'condition': {
        const result = compareValues({
          left: resolveTemplateValue({ template: node.left, context }),
          operator: node.operator,
          right: renderTemplate({ template: node.right, context }),
        });
        branchTaken.set(node.id, result ? 'true' : 'false');
        return { output: { result } };
      }
      case 'switch': {
        const value = resolveTemplateValue({ template: node.value, context });
        const matched = node.rules.findIndex(rule =>
          compareValues({
            left: value,
            operator: rule.operator,
            right: renderTemplate({ template: rule.right, context }),
          }),
        );
        branchTaken.set(node.id, matched === -1 ? 'fallback' : String(matched));
        return { output: { matched: matched === -1 ? null : matched, value } };
      }
      case 'merge': {
        const outputs = upstreamOutputs(node.id);
        if (node.mode === 'append') {
          return { output: outputs };
        }
        const objects = outputs.filter(
          (output): output is Record<string, unknown> =>
            typeof output === 'object' && output !== null && !Array.isArray(output),
        );
        return { output: Object.assign({}, ...objects) };
      }
      case 'wait':
        return handlers.wait({ node, signal });
      case 'stop_and_error':
        throw new WorkflowStepError(renderTemplate({ template: node.message, context }));
      case 'no_op':
        return { output: upstreamOutput(node.id) };
      case 'filter':
        return {
          output: filterItems({
            items: listInput(node),
            field: node.field,
            operator: node.operator,
            right: renderTemplate({ template: node.right, context }),
          }),
        };
      case 'sort':
        return { output: sortItems({ items: listInput(node), field: node.field, order: node.order }) };
      case 'limit':
        return { output: limitItems({ items: listInput(node), maxItems: node.max_items, keep: node.keep }) };
      case 'remove_duplicates':
        return { output: removeDuplicateItems({ items: listInput(node), field: node.field }) };
      case 'split_out':
        return { output: splitOutItems({ items: listInput(node), field: node.field }) };
      case 'aggregate':
        return { output: aggregateItems({ items: listInput(node), field: node.field, operation: node.operation }) };
      case 'date_time':
        return {
          output: computeDateTime({ node, value: renderTemplate({ template: node.value, context }), now: new Date() }),
        };
      case 'crypto':
        return {
          output: computeCrypto({
            node,
            value: renderTemplate({ template: node.value, context }),
            secret: renderTemplate({ template: node.secret, context }),
          }),
        };
      case 'http_request':
        return handlers.http_request({ node, context, signal });
      case 'agent':
        return handlers.agent({
          node,
          context,
          signal,
          // Link the session while the agent is still running so the UI can open it live.
          onSession: async sessionId => {
            step.session_id = sessionId;
            await progress();
          },
        });
    }
  };

  let failure: string | null = null;
  for (const node of ordered) {
    const step = stepsById.get(node.id);
    if (step === undefined) {
      continue;
    }
    const edges = incoming.get(node.id) ?? [];
    const reachable = edges.length === 0 || edges.some(edge => edgeIsActive({ edge, stepsById, branchTaken }));
    if (failure !== null || !reachable) {
      step.status = 'skipped';
      continue;
    }
    if (signal.aborted) {
      failure = 'Workflow run exceeded its time limit';
      step.status = 'skipped';
      continue;
    }

    step.status = 'running';
    step.started_at = new Date().toISOString();
    await progress();
    try {
      const result = await runNode(node, step);
      step.output = capStepOutput(result.output);
      step.session_id = result.session_id ?? step.session_id;
      step.status = 'succeeded';
    } catch (error) {
      step.status = 'failed';
      step.error = errorMessage(error);
      step.output = capStepOutput(error instanceof WorkflowStepError ? error.output : null);
      if (node.on_error === 'stop') {
        failure = `Step ${node.id} failed: ${step.error}`;
      }
    }
    step.finished_at = new Date().toISOString();
    context.nodes[node.id] = { output: step.output };
    await progress();
  }

  return { status: failure === null ? 'succeeded' : 'failed', steps, error: failure };
}
