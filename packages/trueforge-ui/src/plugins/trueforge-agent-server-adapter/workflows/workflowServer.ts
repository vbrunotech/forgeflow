/**
 * Workflow port over HTTP. Uses fetch directly because the generated SDK only gains
 * `client.workflows` when CI regenerates it from the OpenAPI spec.
 */
import { z } from 'zod';

import type {
  ListResult,
  SaveWorkflowRequest,
  Workflow,
  WorkflowManifest,
  WorkflowNode,
  WorkflowRun,
  WorkflowServer,
  WorkflowTrigger,
} from '../../../server/types.js';
import { resolveTrueForgeBaseUrl, type CreateTrueForgeClientOptions } from '../client.js';

const WirePosition = z.object({ x: z.number(), y: z.number() });
const wireNodeBase = {
  id: z.string(),
  name: z.string(),
  position: WirePosition,
  on_error: z.enum(['stop', 'continue']),
};
const WireOperator = z.enum([
  'equals',
  'not_equals',
  'contains',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
]);
const wireListBase = { ...wireNodeBase, input: z.string() };
const WireNode = z.discriminatedUnion('type', [
  z.object({
    ...wireNodeBase,
    type: z.literal('http_request'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.string().optional(),
    timeout_seconds: z.number(),
  }),
  z.object({ ...wireNodeBase, type: z.literal('transform'), values: z.record(z.string(), z.string()) }),
  z.object({
    ...wireNodeBase,
    type: z.literal('condition'),
    left: z.string(),
    operator: WireOperator,
    right: z.string(),
  }),
  z.object({ ...wireNodeBase, type: z.literal('agent'), agent_name: z.string(), task: z.string() }),
  z.object({
    ...wireNodeBase,
    type: z.literal('switch'),
    value: z.string(),
    rules: z.array(z.object({ operator: WireOperator, right: z.string() })),
  }),
  z.object({ ...wireNodeBase, type: z.literal('merge'), mode: z.enum(['append', 'combine']) }),
  z.object({ ...wireNodeBase, type: z.literal('wait'), seconds: z.number() }),
  z.object({ ...wireNodeBase, type: z.literal('stop_and_error'), message: z.string() }),
  z.object({ ...wireNodeBase, type: z.literal('no_op') }),
  z.object({
    ...wireListBase,
    type: z.literal('filter'),
    field: z.string(),
    operator: WireOperator,
    right: z.string(),
  }),
  z.object({ ...wireListBase, type: z.literal('sort'), field: z.string(), order: z.enum(['asc', 'desc']) }),
  z.object({
    ...wireListBase,
    type: z.literal('limit'),
    max_items: z.number(),
    keep: z.enum(['first', 'last']),
  }),
  z.object({ ...wireListBase, type: z.literal('remove_duplicates'), field: z.string() }),
  z.object({ ...wireListBase, type: z.literal('split_out'), field: z.string() }),
  z.object({
    ...wireListBase,
    type: z.literal('aggregate'),
    field: z.string(),
    operation: z.enum(['collect', 'count', 'sum', 'average', 'min', 'max']),
  }),
  z.object({
    ...wireNodeBase,
    type: z.literal('date_time'),
    value: z.string(),
    add_amount: z.number(),
    add_unit: z.enum(['seconds', 'minutes', 'hours', 'days', 'weeks']),
    timezone: z.string(),
  }),
  z.object({
    ...wireNodeBase,
    type: z.literal('crypto'),
    operation: z.enum(['hash', 'hmac', 'uuid']),
    algorithm: z.enum(['md5', 'sha1', 'sha256', 'sha512']),
    encoding: z.enum(['hex', 'base64']),
    value: z.string(),
    secret: z.string(),
  }),
]);
const WireTrigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({ type: z.literal('cron'), cron: z.string(), timezone: z.string() }),
  z.object({ type: z.literal('webhook') }),
]);
const WireManifest = z.object({
  description: z.string(),
  status: z.enum(['active', 'paused']),
  triggers: z.array(WireTrigger),
  nodes: z.array(WireNode),
  edges: z.array(z.object({ source: z.string(), target: z.string(), branch: z.string().optional() })),
});
const WireSubject = z.object({
  subject_id: z.string(),
  subject_type: z.string(),
  subject_display_name: z.string(),
});
const WireWorkflow = z.object({
  id: z.string(),
  name: z.string(),
  manifest: WireManifest,
  webhook_configured: z.boolean(),
  next_run_at: z.string().nullable(),
  created_by_subject: WireSubject,
});
const WireRun = z.object({
  id: z.string(),
  workflow_id: z.string(),
  status: z.enum(['running', 'succeeded', 'failed']),
  trigger_type: z.enum(['manual', 'cron', 'webhook']),
  manifest: WireManifest,
  steps: z.array(
    z.object({
      node_id: z.string(),
      status: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']),
      output: z.unknown(),
      error: z.string().nullable(),
      session_id: z.string().nullable(),
      started_at: z.string().nullable(),
      finished_at: z.string().nullable(),
    }),
  ),
  error: z.string().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
const WirePagination = z.object({
  next_page_token: z.string().nullish(),
  previous_page_token: z.string().nullish(),
});
const WireError = z.object({ error: z.object({ message: z.string() }) });

function toUiNode(wire: z.infer<typeof WireNode>): WorkflowNode {
  const base = { id: wire.id, name: wire.name, position: wire.position, onError: wire.on_error };
  switch (wire.type) {
    case 'http_request':
      return {
        ...base,
        type: 'http_request',
        method: wire.method,
        url: wire.url,
        headers: wire.headers,
        timeoutSeconds: wire.timeout_seconds,
        ...(wire.body === undefined ? {} : { body: wire.body }),
      };
    case 'transform':
      return { ...base, type: 'transform', values: wire.values };
    case 'condition':
      return { ...base, type: 'condition', left: wire.left, operator: wire.operator, right: wire.right };
    case 'agent':
      return { ...base, type: 'agent', agentName: wire.agent_name, task: wire.task };
    case 'switch':
      return { ...base, type: 'switch', value: wire.value, rules: wire.rules };
    case 'merge':
      return { ...base, type: 'merge', mode: wire.mode };
    case 'wait':
      return { ...base, type: 'wait', seconds: wire.seconds };
    case 'stop_and_error':
      return { ...base, type: 'stop_and_error', message: wire.message };
    case 'no_op':
      return { ...base, type: 'no_op' };
    case 'filter':
      return {
        ...base,
        type: 'filter',
        input: wire.input,
        field: wire.field,
        operator: wire.operator,
        right: wire.right,
      };
    case 'sort':
      return { ...base, type: 'sort', input: wire.input, field: wire.field, order: wire.order };
    case 'limit':
      return { ...base, type: 'limit', input: wire.input, maxItems: wire.max_items, keep: wire.keep };
    case 'remove_duplicates':
      return { ...base, type: 'remove_duplicates', input: wire.input, field: wire.field };
    case 'split_out':
      return { ...base, type: 'split_out', input: wire.input, field: wire.field };
    case 'aggregate':
      return { ...base, type: 'aggregate', input: wire.input, field: wire.field, operation: wire.operation };
    case 'date_time':
      return {
        ...base,
        type: 'date_time',
        value: wire.value,
        addAmount: wire.add_amount,
        addUnit: wire.add_unit,
        timezone: wire.timezone,
      };
    case 'crypto':
      return {
        ...base,
        type: 'crypto',
        operation: wire.operation,
        algorithm: wire.algorithm,
        encoding: wire.encoding,
        value: wire.value,
        secret: wire.secret,
      };
  }
}

function toWireNode(node: WorkflowNode): Record<string, unknown> {
  const base = { id: node.id, name: node.name, position: node.position, on_error: node.onError };
  switch (node.type) {
    case 'http_request':
      return {
        ...base,
        type: node.type,
        method: node.method,
        url: node.url,
        headers: node.headers,
        timeout_seconds: node.timeoutSeconds,
        ...(node.body === undefined ? {} : { body: node.body }),
      };
    case 'transform':
      return { ...base, type: node.type, values: node.values };
    case 'condition':
      return { ...base, type: node.type, left: node.left, operator: node.operator, right: node.right };
    case 'agent':
      return { ...base, type: node.type, agent_name: node.agentName, task: node.task };
    case 'limit':
      return { ...base, type: node.type, input: node.input, max_items: node.maxItems, keep: node.keep };
    case 'date_time':
      return {
        ...base,
        type: node.type,
        value: node.value,
        add_amount: node.addAmount,
        add_unit: node.addUnit,
        timezone: node.timezone,
      };
    // These share field names with the wire format, so only `onError` needs renaming.
    case 'switch':
    case 'merge':
    case 'wait':
    case 'stop_and_error':
    case 'no_op':
    case 'filter':
    case 'sort':
    case 'remove_duplicates':
    case 'split_out':
    case 'aggregate':
    case 'crypto': {
      const { onError: _onError, ...fields } = node;
      return { ...fields, on_error: node.onError };
    }
  }
}

function toUiManifest(wire: z.infer<typeof WireManifest>): WorkflowManifest {
  const triggers: WorkflowTrigger[] = wire.triggers;
  return {
    description: wire.description,
    status: wire.status,
    triggers,
    nodes: wire.nodes.map(toUiNode),
    edges: wire.edges.map(edge => ({
      source: edge.source,
      target: edge.target,
      ...(edge.branch === undefined ? {} : { branch: edge.branch }),
    })),
  };
}

function toWireBody({ name, manifest }: SaveWorkflowRequest) {
  return { name, manifest: { ...manifest, nodes: manifest.nodes.map(toWireNode) } };
}

function toUiWorkflow(wire: z.infer<typeof WireWorkflow>): Workflow {
  return {
    id: wire.id,
    name: wire.name,
    manifest: toUiManifest(wire.manifest),
    webhookConfigured: wire.webhook_configured,
    nextRunAt: wire.next_run_at,
    createdBySubject: {
      subjectId: wire.created_by_subject.subject_id,
      subjectType: wire.created_by_subject.subject_type,
      subjectDisplayName: wire.created_by_subject.subject_display_name,
    },
  };
}

function toUiRun(wire: z.infer<typeof WireRun>): WorkflowRun {
  return {
    id: wire.id,
    workflowId: wire.workflow_id,
    status: wire.status,
    triggerType: wire.trigger_type,
    manifest: toUiManifest(wire.manifest),
    steps: wire.steps.map(step => ({
      nodeId: step.node_id,
      status: step.status,
      output: step.output,
      error: step.error,
      sessionId: step.session_id,
      startedAt: step.started_at,
      finishedAt: step.finished_at,
    })),
    error: wire.error,
    createdAt: wire.created_at,
    finishedAt: wire.finished_at,
  };
}

/** `statusCode` is what the toaster reads to title HTTP failures. */
export class WorkflowRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'WorkflowRequestError';
    this.statusCode = statusCode;
  }
}

function pageOf<TWire, TItem>(json: unknown, item: z.ZodType<TWire>, map: (wire: TWire) => TItem): ListResult<TItem> {
  const page = z.object({ data: z.array(item), pagination: WirePagination }).parse(json);
  const next = page.pagination.next_page_token;
  const previous = page.pagination.previous_page_token;
  return {
    data: page.data.map(map),
    ...(next == null ? {} : { nextPageToken: next }),
    ...(previous == null ? {} : { previousPageToken: previous }),
  };
}

export function createWorkflowServer(options: CreateTrueForgeClientOptions = {}): WorkflowServer {
  const baseUrl = resolveTrueForgeBaseUrl(options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);

  const request = async ({ method, path, body }: { method: string; path: string; body?: unknown }) => {
    const response = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = WireError.safeParse(json);
      const message = parsed.success ? parsed.data.error.message : `Request failed (${String(response.status)})`;
      throw new WorkflowRequestError(message, response.status);
    }
    return json;
  };

  const pageQuery = (req?: { limit?: number; pageToken?: string }) => {
    const params = new URLSearchParams();
    if (req?.limit !== undefined) params.set('limit', String(req.limit));
    if (req?.pageToken !== undefined && req.pageToken !== '') params.set('page_token', req.pageToken);
    const query = params.toString();
    return query === '' ? '' : `?${query}`;
  };

  const workflowPath = (workflowId: string) => `/api/v1/workflows/${encodeURIComponent(workflowId)}`;
  const parseWorkflow = (json: unknown) => toUiWorkflow(z.object({ data: WireWorkflow }).parse(json).data);
  const parseRun = (json: unknown) => toUiRun(z.object({ data: WireRun }).parse(json).data);

  return {
    async listWorkflows(req) {
      return pageOf(
        await request({ method: 'GET', path: `/api/v1/workflows${pageQuery(req)}` }),
        WireWorkflow,
        toUiWorkflow,
      );
    },
    async getWorkflow({ workflowId }) {
      return parseWorkflow(await request({ method: 'GET', path: workflowPath(workflowId) }));
    },
    async createWorkflow(req) {
      return parseWorkflow(await request({ method: 'POST', path: '/api/v1/workflows', body: toWireBody(req) }));
    },
    async updateWorkflow({ workflowId, ...req }) {
      return parseWorkflow(await request({ method: 'PUT', path: workflowPath(workflowId), body: toWireBody(req) }));
    },
    async deleteWorkflow({ workflowId }) {
      await request({ method: 'DELETE', path: workflowPath(workflowId) });
    },
    async createWebhookUrl({ workflowId }) {
      const json = await request({ method: 'POST', path: `${workflowPath(workflowId)}/webhook-token`, body: {} });
      const { data } = z.object({ data: z.object({ path: z.string() }) }).parse(json);
      return { url: `${baseUrl}${data.path}` };
    },
    async runWorkflow({ workflowId, input }) {
      return parseRun(await request({ method: 'POST', path: `${workflowPath(workflowId)}/runs`, body: { input } }));
    },
    async listRuns({ workflowId, ...req }) {
      return pageOf(
        await request({ method: 'GET', path: `${workflowPath(workflowId)}/runs${pageQuery(req)}` }),
        WireRun,
        toUiRun,
      );
    },
    async getRun({ workflowId, runId }) {
      return parseRun(
        await request({ method: 'GET', path: `${workflowPath(workflowId)}/runs/${encodeURIComponent(runId)}` }),
      );
    },
  };
}
