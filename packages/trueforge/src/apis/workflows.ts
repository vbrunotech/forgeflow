/**
 * Workflows API (mounted at /api/v1/workflows, /api/v1/workflow-webhooks, /api/internal/workflows).
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { InvalidPageTokenError } from '@truefoundry/trueforge-core/agent-session';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash, randomBytes } from 'node:crypto';
import type { Authorizer } from '../auth/authorizer';
import {
  canCreateOrEdit,
  createdBySubjectFromRequestContext,
  hasAdminRole,
  requestContextFromCreatedBySubject,
  type RequestContext,
  type ResolveRequestContext,
} from '../auth/identity';
import { nextWorkflowRunAt, WORKFLOW_RUN_TIME_LIMIT_MS } from '../controller/workflowDispatch';
import type { IAgentStore } from '../db/agentStore';
import {
  WorkflowNameConflictError,
  type IWorkflowStore,
  type WorkflowRecord,
  type WorkflowRunRecord,
} from '../db/workflowStore';
import { updateLogContext } from '../logger';
import {
  createWorkflowRoute,
  createWorkflowRunRoute,
  createWorkflowWebhookTokenRoute,
  deleteWorkflowRoute,
  executeWorkflowCronRoute,
  getWorkflowRoute,
  getWorkflowRunRoute,
  invokeWorkflowWebhookRoute,
  listWorkflowRunsRoute,
  listWorkflowsRoute,
  putWorkflowRoute,
} from '../routes/workflowRoutes';
import { minIntervalSeconds } from '../runtime/cron';
import { runWorkflowAgentStep, type WorkflowTurnDeps } from '../runtime/workflow/agentStep';
import { executeWorkflow, waitStep } from '../runtime/workflow/engine';
import { InvalidWorkflowError, validateWorkflowGraph } from '../runtime/workflow/graph';
import { runHttpRequestStep } from '../runtime/workflow/httpStep';
import {
  WORKFLOW_MIN_INTERVAL_SECONDS,
  type Workflow,
  type WorkflowManifest,
  type WorkflowRun,
  type WorkflowRunTriggerType,
} from '../schemas/workflow';
import { agentIfAccessible } from './agentAccess';

/** Bounds what one leaked webhook URL or a too-eager cron can make the server do at once. */
export const WORKFLOW_MAX_CONCURRENT_RUNS = 10;

const WEBHOOK_TOKEN_PREFIX = 'tfwh_';
const FORBIDDEN_WORKFLOW_ACCESS = 'Only the workflow creator or an admin can access this workflow';

/** Never forwarded into a run's stored input. */
const SENSITIVE_WEBHOOK_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key']);

export type WorkflowExecutionDeps<TTransaction> = WorkflowTurnDeps<TTransaction> & {
  workflowStore: IWorkflowStore;
};

export type WorkflowsRouterDeps<TTransaction> = WorkflowExecutionDeps<TTransaction> & {
  resolveAgentStore: (c: Context) => IAgentStore<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
  authorizer: Authorizer;
};

class WorkflowBusyError extends Error {
  constructor() {
    super(`This workflow already has ${String(WORKFLOW_MAX_CONCURRENT_RUNS)} runs in progress`);
    this.name = 'WorkflowBusyError';
  }
}

export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toWireWorkflow(record: WorkflowRecord): Workflow {
  return {
    id: record.id,
    name: record.name,
    manifest: record.manifest,
    webhook_configured: record.webhook_token_hash !== null,
    next_run_at: record.next_run_at,
    created_by_subject: record.created_by_subject,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function toWireRun(record: WorkflowRunRecord): WorkflowRun {
  return {
    id: record.id,
    workflow_id: record.workflow_id,
    status: record.status,
    trigger_type: record.trigger_type,
    input: record.input,
    manifest: record.manifest,
    steps: record.steps,
    error: record.error,
    created_by_subject: record.created_by_subject,
    created_at: record.created_at,
    finished_at: record.finished_at,
  };
}

function hasWebhookTrigger(manifest: WorkflowManifest): boolean {
  return manifest.triggers.some(trigger => trigger.type === 'webhook');
}

/** Returns a caller-facing message when the manifest cannot be saved. */
function manifestProblem(manifest: WorkflowManifest): string | undefined {
  try {
    validateWorkflowGraph(manifest);
  } catch (error) {
    if (error instanceof InvalidWorkflowError) {
      return error.message;
    }
    throw error;
  }
  for (const type of ['manual', 'webhook'] as const) {
    if (manifest.triggers.filter(trigger => trigger.type === type).length > 1) {
      return `A workflow can have only one ${type} trigger`;
    }
  }
  for (const trigger of manifest.triggers) {
    if (trigger.type !== 'cron') {
      continue;
    }
    const { cron, timezone } = trigger;
    try {
      const tightest = minIntervalSeconds({ cron, timezone }, new Date());
      if (tightest < WORKFLOW_MIN_INTERVAL_SECONDS) {
        return `Cron expression "${cron}" triggers every ${String(tightest)}s; the minimum interval is ${String(WORKFLOW_MIN_INTERVAL_SECONDS)}s`;
      }
    } catch {
      return `Cron expression "${cron}" has no next trigger time in ${timezone}`;
    }
  }
  return undefined;
}

/** Owning a workflow must not let its creator invoke an agent they cannot use. */
async function firstInaccessibleAgent<TTransaction>(params: {
  c: Context;
  manifest: WorkflowManifest;
  requestContext: RequestContext;
  deps: WorkflowsRouterDeps<TTransaction>;
}): Promise<string | undefined> {
  const { c, manifest, requestContext, deps } = params;
  const names = new Set(manifest.nodes.flatMap(node => (node.type === 'agent' ? [node.agent_name] : [])));
  for (const name of names) {
    const agent = await agentIfAccessible({
      authorizer: deps.authorizer,
      context: requestContext,
      action: 'use',
      agent: await deps.resolveAgentStore(c).getAgent({ tenant_id: requestContext.tenant_id, name }),
    });
    if (agent === undefined) {
      return name;
    }
  }
  return undefined;
}

async function runInBackground<TTransaction>(params: {
  c: Context;
  workflow: WorkflowRecord;
  run: WorkflowRunRecord;
  deps: WorkflowExecutionDeps<TTransaction>;
}): Promise<void> {
  const { c, workflow, run, deps } = params;
  const key = { tenant_id: run.tenant_id, id: run.id };
  try {
    const result = await executeWorkflow({
      manifest: run.manifest,
      trigger: run.input,
      signal: AbortSignal.timeout(WORKFLOW_RUN_TIME_LIMIT_MS),
      handlers: {
        http_request: runHttpRequestStep,
        agent: input => runWorkflowAgentStep({ ...input, c, workflow, run, deps }),
        wait: waitStep,
      },
      onProgress: steps => deps.workflowStore.updateRun({ ...key, steps }),
    });
    await deps.workflowStore.updateRun({ ...key, steps: result.steps, status: result.status, error: result.error });
  } catch (error) {
    deps.logger.error('Workflow run crashed', {
      workflow_id: workflow.id,
      workflow_run_id: run.id,
      error,
      reportable_error: { error, extra: { tenant_id: run.tenant_id, workflow_id: workflow.id } },
    });
    const message = error instanceof Error ? error.message : 'Workflow run failed';
    await deps.workflowStore
      .updateRun({ ...key, steps: run.steps, status: 'failed', error: message })
      .catch(() => undefined);
  }
}

/**
 * Creates a run and starts it without waiting. Always runs as the workflow's creator, so a
 * run's permissions do not depend on who or what triggered it.
 */
async function startWorkflowRun<TTransaction>(params: {
  c: Context;
  workflow: WorkflowRecord;
  triggerType: WorkflowRunTriggerType;
  input: Record<string, unknown>;
  deps: WorkflowExecutionDeps<TTransaction>;
}): Promise<WorkflowRunRecord> {
  const { c, workflow, triggerType, input, deps } = params;
  const running = await deps.workflowStore.countRunningRuns({
    tenant_id: workflow.tenant_id,
    workflow_id: workflow.id,
  });
  if (running >= WORKFLOW_MAX_CONCURRENT_RUNS) {
    throw new WorkflowBusyError();
  }
  c.set(
    'request_context',
    requestContextFromCreatedBySubject({
      tenant_id: workflow.tenant_id,
      created_by_subject: workflow.created_by_subject,
    }),
  );
  const run = await deps.workflowStore.createRun({
    tenant_id: workflow.tenant_id,
    workflow_id: workflow.id,
    trigger_type: triggerType,
    input: { type: triggerType, ...input },
    manifest: workflow.manifest,
    created_by_subject: workflow.created_by_subject,
  });
  void runInBackground({ c, workflow, run, deps });
  return run;
}

export function createWorkflowExecutionRouter<TTransaction>(deps: WorkflowExecutionDeps<TTransaction>) {
  const handler: RouteHandler<typeof executeWorkflowCronRoute> = async c => {
    const { workflow_id: workflowId, scheduled_for: scheduledFor } = c.req.valid('json');
    const workflow = await deps.workflowStore.getWorkflowById({ id: workflowId });
    if (workflow === undefined) {
      return c.json({ error: { message: `Workflow not found: ${workflowId}` } }, 404);
    }
    if (workflow.status !== 'active') {
      return c.body(null, 204);
    }
    updateLogContext({ tenant_id: workflow.tenant_id });
    try {
      await startWorkflowRun({
        c,
        workflow,
        triggerType: 'cron',
        input: { scheduled_for: scheduledFor, body: {} },
        deps,
      });
    } catch (error) {
      // A busy workflow skips this tick: queueing would let a slow workflow pile up without limit.
      if (!(error instanceof WorkflowBusyError)) {
        throw error;
      }
      deps.logger.warn('Skipped cron trigger for busy workflow', { workflow_id: workflow.id });
    }
    return c.body(null, 204);
  };

  const router = new OpenAPIHono();
  router.openapi(executeWorkflowCronRoute, handler);
  return router;
}

export function createWorkflowWebhookRouter<TTransaction>(deps: WorkflowExecutionDeps<TTransaction>) {
  const handler: RouteHandler<typeof invokeWorkflowWebhookRoute> = async c => {
    const { token } = c.req.valid('param');
    const workflow = await deps.workflowStore.getWorkflowByWebhookTokenHash({
      webhook_token_hash: hashWebhookToken(token),
    });
    if (workflow === undefined) {
      return c.json({ error: { message: 'Unknown webhook token' } }, 404);
    }
    if (workflow.status !== 'active' || !hasWebhookTrigger(workflow.manifest)) {
      return c.json({ error: { message: 'This workflow is not accepting webhook calls' } }, 409);
    }
    updateLogContext({ tenant_id: workflow.tenant_id });

    const text = await c.req.text();
    let body: unknown = text;
    if (c.req.header('content-type')?.includes('json') === true) {
      try {
        body = JSON.parse(text);
      } catch {
        // Left as text: rejecting here would lose the delivery, and the workflow can branch on it.
      }
    }
    const headers = Object.fromEntries(
      Object.entries(c.req.header()).filter(([name]) => !SENSITIVE_WEBHOOK_HEADERS.has(name.toLowerCase())),
    );

    try {
      const run = await startWorkflowRun({
        c,
        workflow,
        triggerType: 'webhook',
        input: { body, headers, query: c.req.query() },
        deps,
      });
      return c.json({ data: { run_id: run.id } }, 202);
    } catch (error) {
      if (error instanceof WorkflowBusyError) {
        return c.json({ error: { message: error.message } }, 429);
      }
      throw error;
    }
  };

  const router = new OpenAPIHono();
  router.openapi(invokeWorkflowWebhookRoute, handler);
  return router;
}

export function createWorkflowsRouter<TTransaction>(deps: WorkflowsRouterDeps<TTransaction>) {
  const loadOwned = async (c: Context, id: string) => {
    const requestContext = deps.resolveRequestContext(c);
    const workflow = await deps.workflowStore.getWorkflow({ tenant_id: requestContext.tenant_id, id });
    if (workflow === undefined) {
      return { requestContext, outcome: 'missing' as const };
    }
    if (!canCreateOrEdit(requestContext, workflow.created_by_subject.subject_id)) {
      return { requestContext, outcome: 'forbidden' as const };
    }
    return { requestContext, outcome: 'ok' as const, workflow };
  };

  const listHandler: RouteHandler<typeof listWorkflowsRoute> = async c => {
    const { limit, page_token: pageToken, created_by_me: createdByMe } = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    try {
      const { data, pagination } = await deps.workflowStore.listWorkflows({
        tenant_id: requestContext.tenant_id,
        limit,
        page_token: pageToken,
        created_by_subject_id: !createdByMe && hasAdminRole(requestContext) ? undefined : requestContext.subject.id,
      });
      return c.json({ data: data.map(toWireWorkflow), pagination }, 200);
    } catch (error) {
      if (error instanceof InvalidPageTokenError) {
        throw new HTTPException(400, { message: error.message, cause: error });
      }
      throw error;
    }
  };

  const createHandler: RouteHandler<typeof createWorkflowRoute> = async c => {
    const { name, manifest } = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const problem = manifestProblem(manifest);
    if (problem !== undefined) {
      return c.json({ error: { message: problem } }, 400);
    }
    const missingAgent = await firstInaccessibleAgent({ c, manifest, requestContext, deps });
    if (missingAgent !== undefined) {
      return c.json({ error: { message: `Agent not found: ${missingAgent}` } }, 404);
    }
    try {
      const record = await deps.workflowStore.createWorkflow({
        tenant_id: requestContext.tenant_id,
        name,
        manifest,
        next_run_at: nextWorkflowRunAt({ manifest, from: new Date() }),
        created_by_subject: createdBySubjectFromRequestContext(requestContext),
      });
      return c.json({ data: toWireWorkflow(record) }, 201);
    } catch (error) {
      if (error instanceof WorkflowNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const getHandler: RouteHandler<typeof getWorkflowRoute> = async c => {
    const { workflow_id: id } = c.req.valid('param');
    const loaded = await loadOwned(c, id);
    if (loaded.outcome === 'missing') {
      return c.json({ error: { message: `Workflow not found: ${id}` } }, 404);
    }
    if (loaded.outcome === 'forbidden') {
      return c.json({ error: { message: FORBIDDEN_WORKFLOW_ACCESS } }, 403);
    }
    return c.json({ data: toWireWorkflow(loaded.workflow) }, 200);
  };

  const putHandler: RouteHandler<typeof putWorkflowRoute> = async c => {
    const { workflow_id: id } = c.req.valid('param');
    const { name, manifest } = c.req.valid('json');
    const loaded = await loadOwned(c, id);
    if (loaded.outcome === 'missing') {
      return c.json({ error: { message: `Workflow not found: ${id}` } }, 404);
    }
    if (loaded.outcome === 'forbidden') {
      return c.json({ error: { message: FORBIDDEN_WORKFLOW_ACCESS } }, 403);
    }
    const problem = manifestProblem(manifest);
    if (problem !== undefined) {
      return c.json({ error: { message: problem } }, 400);
    }
    const missingAgent = await firstInaccessibleAgent({
      c,
      manifest,
      requestContext: loaded.requestContext,
      deps,
    });
    if (missingAgent !== undefined) {
      return c.json({ error: { message: `Agent not found: ${missingAgent}` } }, 404);
    }
    try {
      const record = await deps.workflowStore.updateWorkflow({
        tenant_id: loaded.requestContext.tenant_id,
        id,
        name,
        manifest,
        next_run_at: nextWorkflowRunAt({ manifest, from: new Date() }),
      });
      if (record === undefined) {
        return c.json({ error: { message: `Workflow not found: ${id}` } }, 404);
      }
      return c.json({ data: toWireWorkflow(record) }, 200);
    } catch (error) {
      if (error instanceof WorkflowNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const deleteHandler: RouteHandler<typeof deleteWorkflowRoute> = async c => {
    const { workflow_id: id } = c.req.valid('param');
    const loaded = await loadOwned(c, id);
    if (loaded.outcome === 'forbidden') {
      return c.json({ error: { message: FORBIDDEN_WORKFLOW_ACCESS } }, 403);
    }
    if (loaded.outcome === 'ok') {
      await deps.workflowStore.deleteWorkflow({ tenant_id: loaded.requestContext.tenant_id, id });
    }
    return c.json({}, 200);
  };

  const webhookTokenHandler: RouteHandler<typeof createWorkflowWebhookTokenRoute> = async c => {
    const { workflow_id: id } = c.req.valid('param');
    const loaded = await loadOwned(c, id);
    if (loaded.outcome === 'missing') {
      return c.json({ error: { message: `Workflow not found: ${id}` } }, 404);
    }
    if (loaded.outcome === 'forbidden') {
      return c.json({ error: { message: FORBIDDEN_WORKFLOW_ACCESS } }, 403);
    }
    if (!hasWebhookTrigger(loaded.workflow.manifest)) {
      return c.json({ error: { message: 'This workflow does not have a webhook trigger' } }, 400);
    }
    const token = `${WEBHOOK_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    await deps.workflowStore.setWebhookTokenHash({
      tenant_id: loaded.requestContext.tenant_id,
      id,
      webhook_token_hash: hashWebhookToken(token),
    });
    return c.json({ data: { token, path: `/api/v1/workflow-webhooks/${token}` } }, 201);
  };

  const createRunHandler: RouteHandler<typeof createWorkflowRunRoute> = async c => {
    const { workflow_id: id } = c.req.valid('param');
    const { input } = c.req.valid('json');
    const loaded = await loadOwned(c, id);
    if (loaded.outcome === 'missing') {
      return c.json({ error: { message: `Workflow not found: ${id}` } }, 404);
    }
    if (loaded.outcome === 'forbidden') {
      return c.json({ error: { message: FORBIDDEN_WORKFLOW_ACCESS } }, 403);
    }
    const missingAgent = await firstInaccessibleAgent({
      c,
      manifest: loaded.workflow.manifest,
      requestContext: loaded.requestContext,
      deps,
    });
    if (missingAgent !== undefined) {
      return c.json({ error: { message: `Agent not found: ${missingAgent}` } }, 404);
    }
    try {
      const run = await startWorkflowRun({
        c,
        workflow: loaded.workflow,
        triggerType: 'manual',
        input: { body: input },
        deps,
      });
      return c.json({ data: toWireRun(run) }, 201);
    } catch (error) {
      if (error instanceof WorkflowBusyError) {
        return c.json({ error: { message: error.message } }, 429);
      }
      throw error;
    }
  };

  const listRunsHandler: RouteHandler<typeof listWorkflowRunsRoute> = async c => {
    const { workflow_id: id } = c.req.valid('param');
    const { limit, page_token: pageToken } = c.req.valid('query');
    const loaded = await loadOwned(c, id);
    if (loaded.outcome === 'missing') {
      return c.json({ error: { message: `Workflow not found: ${id}` } }, 404);
    }
    if (loaded.outcome === 'forbidden') {
      return c.json({ error: { message: FORBIDDEN_WORKFLOW_ACCESS } }, 403);
    }
    try {
      const { data, pagination } = await deps.workflowStore.listRuns({
        tenant_id: loaded.requestContext.tenant_id,
        workflow_id: id,
        limit,
        page_token: pageToken,
      });
      return c.json({ data: data.map(toWireRun), pagination }, 200);
    } catch (error) {
      if (error instanceof InvalidPageTokenError) {
        throw new HTTPException(400, { message: error.message, cause: error });
      }
      throw error;
    }
  };

  const getRunHandler: RouteHandler<typeof getWorkflowRunRoute> = async c => {
    const { workflow_id: id, run_id: runId } = c.req.valid('param');
    const loaded = await loadOwned(c, id);
    if (loaded.outcome === 'missing') {
      return c.json({ error: { message: `Workflow not found: ${id}` } }, 404);
    }
    if (loaded.outcome === 'forbidden') {
      return c.json({ error: { message: FORBIDDEN_WORKFLOW_ACCESS } }, 403);
    }
    const run = await deps.workflowStore.getRun({
      tenant_id: loaded.requestContext.tenant_id,
      workflow_id: id,
      id: runId,
    });
    if (run === undefined) {
      return c.json({ error: { message: `Workflow run not found: ${runId}` } }, 404);
    }
    return c.json({ data: toWireRun(run) }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listWorkflowsRoute, listHandler);
  router.openapi(createWorkflowRoute, createHandler);
  router.openapi(getWorkflowRoute, getHandler);
  router.openapi(putWorkflowRoute, putHandler);
  router.openapi(deleteWorkflowRoute, deleteHandler);
  router.openapi(createWorkflowWebhookTokenRoute, webhookTokenHandler);
  router.openapi(createWorkflowRunRoute, createRunHandler);
  router.openapi(listWorkflowRunsRoute, listRunsHandler);
  router.openapi(getWorkflowRunRoute, getRunHandler);
  return router;
}
