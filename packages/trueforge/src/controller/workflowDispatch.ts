import type { Logger } from 'winston';
import type { IWorkflowStore, WorkflowRecord } from '../db/workflowStore';
import { nextTriggerAfter } from '../runtime/cron';
import { InvalidCronError } from '../schemas/schedule';
import type { WorkflowManifest } from '../schemas/workflow';
import type { ControlLoop } from './Controller';
import { internalTrueForgeClient } from './internalTrueForgeClient';

const WORKFLOW_DISPATCH_INTERVAL_MS = 30_000;
const WORKFLOW_DISPATCH_BATCH_LIMIT = 50;

/** A run gets one hour; past two, nothing can still be working on it. */
export const WORKFLOW_RUN_TIME_LIMIT_MS = 60 * 60 * 1000;
const WORKFLOW_STALE_RUN_MS = 2 * WORKFLOW_RUN_TIME_LIMIT_MS;

/** Earliest next instant across an active workflow's schedules; null when it has none. */
export function nextWorkflowRunAt({ manifest, from }: { manifest: WorkflowManifest; from: Date }): Date | null {
  if (manifest.status !== 'active') {
    return null;
  }
  let earliest: Date | null = null;
  for (const trigger of manifest.triggers) {
    if (trigger.type !== 'cron') {
      continue;
    }
    let next: Date;
    try {
      next = nextTriggerAfter({ cron: trigger.cron, timezone: trigger.timezone, from });
    } catch (error) {
      if (error instanceof InvalidCronError) {
        continue;
      }
      throw error;
    }
    if (earliest === null || next < earliest) {
      earliest = next;
    }
  }
  return earliest;
}

/**
 * Advances `next_run_at` before handing off, so a crash between the two drops one trigger
 * rather than firing it twice: a workflow may have side effects, so at-most-once is the
 * safe failure mode. Triggers missed while the server was down are not replayed.
 */
export async function dispatchDueWorkflows(params: {
  store: IWorkflowStore;
  onDue: (workflow: WorkflowRecord, scheduledFor: Date) => Promise<void>;
  logger: Logger;
  now: Date;
  signal?: AbortSignal;
}): Promise<{ dispatched: number; failed: number }> {
  const { store, onDue, logger, now, signal } = params;
  const due = await store.listDueCronWorkflows({ until: now, limit: WORKFLOW_DISPATCH_BATCH_LIMIT });
  let dispatched = 0;
  let failed = 0;
  for (const workflow of due) {
    if (signal?.aborted) {
      break;
    }
    try {
      await store.setNextRunAt({
        tenant_id: workflow.tenant_id,
        id: workflow.id,
        next_run_at: nextWorkflowRunAt({ manifest: workflow.manifest, from: now }),
      });
      await onDue(workflow, now);
      dispatched += 1;
    } catch (error) {
      failed += 1;
      logger.error('Failed to dispatch workflow', {
        workflow_id: workflow.id,
        error,
        reportable_error: { error, extra: { tenant_id: workflow.tenant_id, workflow_id: workflow.id } },
      });
    }
  }
  return { dispatched, failed };
}

export function workflowDispatchLoop(params: { workflowStore: IWorkflowStore; logger: Logger }): ControlLoop {
  const { workflowStore, logger } = params;
  return {
    name: 'workflow-dispatch',
    intervalMs: WORKFLOW_DISPATCH_INTERVAL_MS,
    async tick(signal: AbortSignal): Promise<void> {
      const now = new Date();
      await workflowStore.failStaleRuns({
        before: new Date(now.getTime() - WORKFLOW_STALE_RUN_MS),
        error: 'Workflow run was interrupted before it finished',
      });
      await dispatchDueWorkflows({
        store: workflowStore,
        onDue: (workflow, scheduledFor) =>
          internalTrueForgeClient.executeWorkflowCron({ workflowId: workflow.id, scheduledFor }),
        logger,
        now,
        signal,
      });
    },
  };
}
