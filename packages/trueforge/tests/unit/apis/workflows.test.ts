import { OpenAPIHono, z } from '@hono/zod-openapi';
import {
  AgentSpecSchema,
  InMemorySessionStore,
  Sessions,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import winston from 'winston';
import {
  createWorkflowExecutionRouter,
  createWorkflowsRouter,
  createWorkflowWebhookRouter,
  WORKFLOW_MAX_CONCURRENT_RUNS,
} from '../../../src/apis/workflows';
import { TrueForgeAuthorizer } from '../../../src/auth/authorizer';
import type { RequestContext } from '../../../src/auth/identity';
import { dispatchDueWorkflows, nextWorkflowRunAt } from '../../../src/controller/workflowDispatch';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteWorkflowStore } from '../../../src/db/sqlite/workflow-store/SqliteWorkflowStore';
import { parseStoredWorkflowManifest } from '../../../src/db/workflowStore';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import {
  GetWorkflowResponseSchema,
  GetWorkflowRunResponseSchema,
  ListWorkflowsResponseSchema,
  WorkflowManifestSchema,
} from '../../../src/schemas/workflow';

const user = (id: string, roles: string[] = []): RequestContext => ({
  tenant_id: 'default',
  subject: { id, type: 'user', display_name: id },
  roles,
  user_credential: null,
});
const ALICE = user('alice');
const BOB = user('bob');
const ADMIN = user('root', ['admin']);

const position = { x: 0, y: 0 };
const transformNode = {
  id: 'shape',
  name: 'Shape',
  position,
  type: 'transform',
  values: { who: '{{ trigger.body.who }}' },
};
const manualBody = { name: 'hello-flow', manifest: { triggers: [{ type: 'manual' }], nodes: [transformNode] } };
const webhookBody = { name: 'hook-flow', manifest: { triggers: [{ type: 'webhook' }], nodes: [transformNode] } };

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const agentStore = new SqliteAgentStore(db);
  const workflowStore = new SqliteWorkflowStore(db);
  await agentStore.createAgent({
    tenant_id: 'default',
    created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
    name: 'reporter',
    description: 'Test agent.',
    manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
    external_id: 'reporter-external-id',
  });

  let current = ALICE;
  const executionDeps = {
    workflowStore,
    sessions: new Sessions({ sessionStore: new InMemorySessionStore() }),
    agentStore,
    activeTurns: new ActiveTurnRegistry(),
    eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
    logger: winston.createLogger({ silent: true }),
    resolveModelProviderStore: () => ({}) as never,
    resolveMcpServerStore: () => ({}) as never,
    resolveTurnSkillsStore: () => ({ resolveTurnSkills: async () => [] }),
    resolveCapabilitiesStore: () => ({ resolveCapabilities: () => [] }),
    resolveSandboxProviderStore: () => ({}) as never,
    sandboxEnvironmentStore: {} as never,
    resolveWebSearchProviderStore: () => ({}) as never,
  };
  const app = new OpenAPIHono();
  app.route('/internal', createWorkflowExecutionRouter(executionDeps));
  app.route('/hooks', createWorkflowWebhookRouter(executionDeps));
  app.route(
    '/',
    createWorkflowsRouter({
      ...executionDeps,
      resolveAgentStore: () => agentStore,
      resolveRequestContext: () => current,
      authorizer: new TrueForgeAuthorizer(),
    }),
  );
  const post = (path: string, body: unknown = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const create = async (body: unknown) => {
    const res = await post('/', body);
    expect(res.status).toBe(201);
    return GetWorkflowResponseSchema.parse(await res.json()).data;
  };
  const waitForRun = async (workflowId: string, runId: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const res = await app.request(`/${workflowId}/runs/${runId}`);
      const { data } = GetWorkflowRunResponseSchema.parse(await res.json());
      if (data.status !== 'running') {
        return data;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('run did not finish');
  };
  return {
    app,
    post,
    create,
    waitForRun,
    workflowStore,
    asUser: (next: RequestContext) => {
      current = next;
    },
  };
}

describe('workflows API', () => {
  it('runs a workflow and records each step', async () => {
    const { post, create, waitForRun } = await setup();
    const workflow = await create(manualBody);
    const res = await post(`/${workflow.id}/runs`, { input: { who: 'Ada' } });
    expect(res.status).toBe(201);
    const { data: started } = GetWorkflowRunResponseSchema.parse(await res.json());
    const finished = await waitForRun(workflow.id, started.id);
    expect(finished.status).toBe('succeeded');
    expect(finished.trigger_type).toBe('manual');
    expect(finished.steps[0]).toMatchObject({ node_id: 'shape', status: 'succeeded', output: { who: 'Ada' } });
  });

  it('keeps workflows private to their creator and admins', async () => {
    const { app, post, create, asUser } = await setup();
    const workflow = await create(manualBody);

    asUser(BOB);
    expect((await app.request(`/${workflow.id}`)).status).toBe(403);
    expect((await app.request(`/${workflow.id}/runs`)).status).toBe(403);
    expect((await post(`/${workflow.id}/runs`)).status).toBe(403);
    expect((await post(`/${workflow.id}/webhook-token`)).status).toBe(403);
    expect((await app.request(`/${workflow.id}`, { method: 'DELETE' })).status).toBe(403);
    expect(ListWorkflowsResponseSchema.parse(await (await app.request('/')).json()).data).toEqual([]);

    asUser(ADMIN);
    expect((await app.request(`/${workflow.id}`)).status).toBe(200);
    expect(ListWorkflowsResponseSchema.parse(await (await app.request('/')).json()).data).toHaveLength(1);
  });

  it('rejects invalid graphs, impossible crons, duplicate names, and unknown agents', async () => {
    const { post, create } = await setup();
    await create(manualBody);
    expect((await post('/', manualBody)).status).toBe(409);
    const cyclic = await post('/', {
      name: 'cyclic',
      manifest: { ...manualBody.manifest, edges: [{ source: 'shape', target: 'shape' }] },
    });
    expect(cyclic.status).toBe(400);
    const impossibleCron = await post('/', {
      name: 'never-fires',
      manifest: { ...manualBody.manifest, triggers: [{ type: 'manual' }, { type: 'cron', cron: '0 0 31 2 *' }] },
    });
    expect(impossibleCron.status).toBe(400);
    const twoWebhooks = await post('/', {
      name: 'two-hooks',
      manifest: { ...manualBody.manifest, triggers: [{ type: 'webhook' }, { type: 'webhook' }] },
    });
    expect(twoWebhooks.status).toBe(400);
    const noTrigger = await post('/', { name: 'no-trigger', manifest: { ...manualBody.manifest, triggers: [] } });
    expect(noTrigger.status).toBe(400);
    const unknownAgent = await post('/', {
      name: 'needs-agent',
      manifest: {
        triggers: [{ type: 'manual' }],
        nodes: [{ id: 'think', name: 'Think', position, type: 'agent', agent_name: 'ghost', task: 'Go' }],
      },
    });
    expect(unknownAgent.status).toBe(404);
  });

  it('accepts webhook calls only with a current token, and hides credentials from the run', async () => {
    const { app, post, create, waitForRun, workflowStore } = await setup();
    const workflow = await create(webhookBody);
    expect((await post('/hooks/tfwh_unknown')).status).toBe(404);

    const issue = await post(`/${workflow.id}/webhook-token`);
    expect(issue.status).toBe(201);
    const { data: tokenData } = z
      .object({ data: z.object({ token: z.string(), path: z.string() }) })
      .parse(await issue.json());
    const stored = await workflowStore.getWorkflow({ tenant_id: 'default', id: workflow.id });
    expect(stored?.webhook_token_hash).not.toContain(tokenData.token);

    const res = await app.request(`/hooks/${tokenData.token}?source=ci`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret', 'x-event': 'push' },
      body: JSON.stringify({ who: 'webhook' }),
    });
    expect(res.status).toBe(202);
    const { data } = z.object({ data: z.object({ run_id: z.string() }) }).parse(await res.json());
    const run = await waitForRun(workflow.id, data.run_id);
    expect(run.steps[0]?.output).toEqual({ who: 'webhook' });
    expect(run.input).toMatchObject({ type: 'webhook', query: { source: 'ci' } });
    expect(JSON.stringify(run.input)).not.toContain('secret');
    expect(JSON.stringify(run.input)).toContain('push');

    // Issuing a new token revokes the old one.
    await post(`/${workflow.id}/webhook-token`);
    expect((await post(`/hooks/${tokenData.token}`)).status).toBe(404);
  });

  it('refuses webhook calls while paused and tokens for other trigger types', async () => {
    const { app, post, create } = await setup();
    const manual = await create(manualBody);
    expect((await post(`/${manual.id}/webhook-token`)).status).toBe(400);

    const workflow = await create(webhookBody);
    const { data } = z
      .object({ data: z.object({ token: z.string() }) })
      .parse(await (await post(`/${workflow.id}/webhook-token`)).json());
    const paused = await app.request(`/${workflow.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: webhookBody.name, manifest: { ...webhookBody.manifest, status: 'paused' } }),
    });
    expect(paused.status).toBe(200);
    expect((await post(`/hooks/${data.token}`)).status).toBe(409);
  });

  it('caps concurrent runs of one workflow', async () => {
    const { post, create, workflowStore } = await setup();
    const workflow = await create(manualBody);
    for (let index = 0; index < WORKFLOW_MAX_CONCURRENT_RUNS; index += 1) {
      await workflowStore.createRun({
        tenant_id: 'default',
        workflow_id: workflow.id,
        trigger_type: 'manual',
        input: {},
        manifest: workflow.manifest,
        created_by_subject: workflow.created_by_subject,
      });
    }
    expect((await post(`/${workflow.id}/runs`)).status).toBe(429);
  });

  it('fails runs stranded by a dead process', async () => {
    const { create, workflowStore } = await setup();
    const workflow = await create(manualBody);
    const run = await workflowStore.createRun({
      tenant_id: 'default',
      workflow_id: workflow.id,
      trigger_type: 'manual',
      input: {},
      manifest: workflow.manifest,
      created_by_subject: workflow.created_by_subject,
    });
    expect(await workflowStore.failStaleRuns({ before: new Date(Date.parse(run.created_at) - 1), error: 'x' })).toBe(0);
    expect(await workflowStore.failStaleRuns({ before: new Date(Date.parse(run.created_at) + 1), error: 'gone' })).toBe(
      1,
    );
    const updated = await workflowStore.getRun({ tenant_id: 'default', workflow_id: workflow.id, id: run.id });
    expect(updated).toMatchObject({ status: 'failed', error: 'gone' });
    expect(updated?.finished_at).not.toBeNull();
  });
});

describe('workflow cron dispatch', () => {
  const cronManifest = WorkflowManifestSchema.parse({
    triggers: [{ type: 'cron', cron: '0 9 * * *', timezone: 'UTC' }],
    nodes: [transformNode],
  });

  it('only schedules active cron workflows', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(nextWorkflowRunAt({ manifest: cronManifest, from })?.toISOString()).toBe('2026-01-01T09:00:00.000Z');
    expect(nextWorkflowRunAt({ manifest: { ...cronManifest, status: 'paused' }, from })).toBeNull();
    expect(nextWorkflowRunAt({ manifest: { ...cronManifest, triggers: [{ type: 'manual' }] }, from })).toBeNull();
  });

  it('runs at the earliest of several schedules', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const manifest = {
      ...cronManifest,
      triggers: [
        { type: 'webhook' as const },
        { type: 'cron' as const, cron: '0 9 * * *', timezone: 'UTC' },
        { type: 'cron' as const, cron: '30 6 * * *', timezone: 'UTC' },
      ],
    };
    expect(nextWorkflowRunAt({ manifest, from })?.toISOString()).toBe('2026-01-01T06:30:00.000Z');
  });

  it('reads workflows saved with a single trigger as a one-item list', () => {
    const stored = { ...cronManifest, triggers: undefined, trigger: { type: 'webhook' } };
    expect(parseStoredWorkflowManifest(stored).triggers).toEqual([{ type: 'webhook' }]);
  });

  it('advances before handing off, so a failed handoff is not retried on the next tick', async () => {
    const { workflowStore } = await setup();
    const due = new Date('2026-01-01T09:00:00Z');
    const workflow = await workflowStore.createWorkflow({
      tenant_id: 'default',
      name: 'cron-flow',
      manifest: cronManifest,
      next_run_at: due,
      created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
    });
    const now = new Date('2026-01-01T09:00:10Z');
    const logger = winston.createLogger({ silent: true });
    const onDue = jest.fn().mockRejectedValueOnce(new Error('server down'));

    expect(await dispatchDueWorkflows({ store: workflowStore, onDue, logger, now })).toEqual({
      dispatched: 0,
      failed: 1,
    });
    const after = await workflowStore.getWorkflow({ tenant_id: 'default', id: workflow.id });
    expect(after?.next_run_at).toBe('2026-01-02T09:00:00.000Z');
    expect(await dispatchDueWorkflows({ store: workflowStore, onDue, logger, now })).toEqual({
      dispatched: 0,
      failed: 0,
    });
    expect(onDue).toHaveBeenCalledTimes(1);
  });
});

describe('cron trigger endpoint', () => {
  it('starts a run for an active workflow and ignores a paused one', async () => {
    const { post, create, workflowStore } = await setup();
    const workflow = await create(manualBody);
    expect(
      (await post('/internal/runs/execute', { workflow_id: workflow.id, scheduled_for: '2026-01-01T09:00:00.000Z' }))
        .status,
    ).toBe(204);
    const { data } = await workflowStore.listRuns({
      tenant_id: 'default',
      workflow_id: workflow.id,
      limit: 5,
      page_token: undefined,
    });
    expect(data[0]?.trigger_type).toBe('cron');
    expect(
      (await post('/internal/runs/execute', { workflow_id: 'missing', scheduled_for: '2026-01-01T09:00:00.000Z' }))
        .status,
    ).toBe(404);
  });
});
