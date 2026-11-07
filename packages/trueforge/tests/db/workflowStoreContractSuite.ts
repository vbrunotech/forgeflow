import type { IWorkflowStore } from '../../src/db/workflowStore';
import { WorkflowNameConflictError } from '../../src/db/workflowStore';
import { WorkflowManifestSchema, type WorkflowRunStep } from '../../src/schemas/workflow';

const created_by_subject = { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' };
const manifest = WorkflowManifestSchema.parse({
  triggers: [{ type: 'cron', cron: '0 9 * * *', timezone: 'UTC' }],
  nodes: [{ id: 'shape', name: 'Shape', position: { x: 1.5, y: 2 }, type: 'transform', values: { a: '{{ x }}' } }],
});
const step: WorkflowRunStep = {
  node_id: 'shape',
  status: 'succeeded',
  output: { nested: { list: [1, 'two', null] } },
  error: null,
  session_id: null,
  started_at: '2026-01-01T00:00:00.000Z',
  finished_at: '2026-01-01T00:00:01.000Z',
};

export function runWorkflowStoreContractSuite(deps: { getStore: () => IWorkflowStore }): void {
  const create = (name: string, overrides: { next_run_at?: Date | null; tenant_id?: string } = {}) =>
    deps.getStore().createWorkflow({
      tenant_id: overrides.tenant_id ?? 'default',
      name,
      manifest,
      next_run_at: overrides.next_run_at ?? null,
      created_by_subject,
    });
  const createRun = (workflowId: string) =>
    deps.getStore().createRun({
      tenant_id: 'default',
      workflow_id: workflowId,
      trigger_type: 'manual',
      input: { body: { who: 'Ada' } },
      manifest,
      created_by_subject,
    });

  it('round-trips a workflow, including defaults and JSON', async () => {
    const created = await create('round-trip', { next_run_at: new Date('2030-01-01T09:00:00.000Z') });
    const loaded = await deps.getStore().getWorkflow({ tenant_id: 'default', id: created.id });
    expect(loaded).toMatchObject({
      name: 'round-trip',
      status: 'active',
      webhook_token_hash: null,
      next_run_at: '2030-01-01T09:00:00.000Z',
      created_by_subject,
    });
    expect(loaded?.manifest).toEqual(manifest);
    expect(await deps.getStore().getWorkflowById({ id: created.id })).toEqual(loaded);
  });

  it('scopes reads to the tenant and names to the tenant', async () => {
    const created = await create('shared-name');
    expect(await deps.getStore().getWorkflow({ tenant_id: 'other', id: created.id })).toBeUndefined();
    await expect(create('shared-name')).rejects.toBeInstanceOf(WorkflowNameConflictError);
    await expect(create('shared-name', { tenant_id: 'other' })).resolves.toBeDefined();
  });

  it('updates the mirrored status and rejects renaming onto a taken name', async () => {
    const first = await create('first-flow');
    await create('second-flow');
    const paused = { ...manifest, status: 'paused' as const };
    const updated = await deps.getStore().updateWorkflow({
      tenant_id: 'default',
      id: first.id,
      name: 'first-renamed',
      manifest: paused,
      next_run_at: null,
    });
    expect(updated).toMatchObject({ name: 'first-renamed', status: 'paused', next_run_at: null });
    await expect(
      deps.getStore().updateWorkflow({
        tenant_id: 'default',
        id: first.id,
        name: 'second-flow',
        manifest,
        next_run_at: null,
      }),
    ).rejects.toBeInstanceOf(WorkflowNameConflictError);
    expect(
      await deps
        .getStore()
        .updateWorkflow({ tenant_id: 'default', id: 'missing', name: 'x-y', manifest, next_run_at: null }),
    ).toBeUndefined();
  });

  it('finds a workflow by webhook token hash and replaces the old hash', async () => {
    const created = await create('hooked');
    const key = { tenant_id: 'default', id: created.id };
    await deps.getStore().setWebhookTokenHash({ ...key, webhook_token_hash: 'hash-1' });
    expect((await deps.getStore().getWorkflowByWebhookTokenHash({ webhook_token_hash: 'hash-1' }))?.id).toBe(
      created.id,
    );
    await deps.getStore().setWebhookTokenHash({ ...key, webhook_token_hash: 'hash-2' });
    expect(await deps.getStore().getWorkflowByWebhookTokenHash({ webhook_token_hash: 'hash-1' })).toBeUndefined();
  });

  it('lists newest first with pagination and an optional creator filter', async () => {
    await create('list-a');
    await create('list-b');
    await create('list-c');
    const firstPage = await deps
      .getStore()
      .listWorkflows({ tenant_id: 'default', limit: 2, page_token: undefined, created_by_subject_id: undefined });
    expect(firstPage.data).toHaveLength(2);
    const token = firstPage.pagination.next_page_token ?? undefined;
    expect(token).toBeDefined();
    const secondPage = await deps
      .getStore()
      .listWorkflows({ tenant_id: 'default', limit: 2, page_token: token, created_by_subject_id: undefined });
    expect(secondPage.data).toHaveLength(1);
    const noneForBob = await deps
      .getStore()
      .listWorkflows({ tenant_id: 'default', limit: 2, page_token: undefined, created_by_subject_id: 'bob' });
    expect(noneForBob.data).toEqual([]);
    const forAlice = await deps
      .getStore()
      .listWorkflows({ tenant_id: 'default', limit: 5, page_token: undefined, created_by_subject_id: 'alice' });
    expect(forAlice.data).toHaveLength(3);
  });

  it('lists only due, active workflows, oldest first', async () => {
    const until = new Date('2030-01-01T10:00:00.000Z');
    const later = await create('due-later', { next_run_at: new Date('2030-01-01T09:30:00.000Z') });
    const earlier = await create('due-earlier', { next_run_at: new Date('2030-01-01T09:00:00.000Z') });
    await create('not-due', { next_run_at: new Date('2030-01-01T11:00:00.000Z') });
    await create('no-cron');
    const due = await deps.getStore().listDueCronWorkflows({ until, limit: 10 });
    expect(due.map(workflow => workflow.id)).toEqual([earlier.id, later.id]);

    await deps.getStore().setNextRunAt({ tenant_id: 'default', id: earlier.id, next_run_at: null });
    const remaining = await deps.getStore().listDueCronWorkflows({ until, limit: 10 });
    expect(remaining.map(workflow => workflow.id)).toEqual([later.id]);
  });

  it('tracks a run from running to finished, keeping JSON output intact', async () => {
    const workflow = await create('with-runs');
    const run = await createRun(workflow.id);
    expect(run).toMatchObject({ status: 'running', steps: [], error: null, finished_at: null });
    expect(run.input).toEqual({ body: { who: 'Ada' } });
    const key = { tenant_id: 'default', workflow_id: workflow.id };
    expect(await deps.getStore().countRunningRuns(key)).toBe(1);

    await deps.getStore().updateRun({ tenant_id: 'default', id: run.id, steps: [step] });
    const progress = await deps.getStore().getRun({ ...key, id: run.id });
    expect(progress).toMatchObject({ status: 'running', steps: [step], finished_at: null });

    await deps
      .getStore()
      .updateRun({ tenant_id: 'default', id: run.id, steps: [step], status: 'failed', error: 'boom' });
    const finished = await deps.getStore().getRun({ ...key, id: run.id });
    expect(finished).toMatchObject({ status: 'failed', error: 'boom' });
    expect(finished?.finished_at).not.toBeNull();
    expect(finished?.manifest).toEqual(manifest);
    expect(await deps.getStore().countRunningRuns(key)).toBe(0);
  });

  it('pages run history and cascades delete', async () => {
    const workflow = await create('history');
    const first = await createRun(workflow.id);
    const second = await createRun(workflow.id);
    const key = { tenant_id: 'default', workflow_id: workflow.id };
    const { data, pagination } = await deps.getStore().listRuns({ ...key, limit: 1, page_token: undefined });
    expect(data).toHaveLength(1);
    const next = await deps
      .getStore()
      .listRuns({ ...key, limit: 1, page_token: pagination.next_page_token ?? undefined });
    expect([data[0]?.id, next.data[0]?.id].sort()).toEqual([first.id, second.id].sort());

    await deps.getStore().deleteWorkflow({ tenant_id: 'default', id: workflow.id });
    await deps.getStore().deleteWorkflow({ tenant_id: 'default', id: workflow.id });
    expect(await deps.getStore().getWorkflow({ tenant_id: 'default', id: workflow.id })).toBeUndefined();
    expect(await deps.getStore().getRun({ ...key, id: first.id })).toBeUndefined();
  });

  it('fails only runs that are stale and still running', async () => {
    const workflow = await create('stale');
    const stale = await createRun(workflow.id);
    const done = await createRun(workflow.id);
    await deps.getStore().updateRun({ tenant_id: 'default', id: done.id, steps: [], status: 'succeeded', error: null });
    const key = { tenant_id: 'default', workflow_id: workflow.id };

    expect(await deps.getStore().failStaleRuns({ before: new Date('2000-01-01T00:00:00Z'), error: 'gone' })).toBe(0);
    expect(await deps.getStore().failStaleRuns({ before: new Date('2100-01-01T00:00:00Z'), error: 'gone' })).toBe(1);
    expect(await deps.getStore().getRun({ ...key, id: stale.id })).toMatchObject({ status: 'failed', error: 'gone' });
    expect((await deps.getStore().getRun({ ...key, id: done.id }))?.status).toBe('succeeded');
  });
}
