import { CreatedBySubjectSchema, type TokenPagination } from '@truefoundry/trueforge-core/agent-session';
import {
  decodeOffsetPageToken,
  paginateOffsetRows,
} from '@truefoundry/trueforge-core/agent-session/store/OffsetPageToken';
import { sql, type Kysely, type Selectable, type UpdateObject } from 'kysely';
import { newId } from '../../../utils/id';
import {
  parseStoredWorkflowManifest,
  WorkflowNameConflictError,
  type CreateWorkflowInput,
  type CreateWorkflowRunInput,
  type IWorkflowStore,
  type ListWorkflowRunsInput,
  type ListWorkflowsInput,
  type UpdateWorkflowInput,
  type UpdateWorkflowRunInput,
  type WorkflowKey,
  type WorkflowRecord,
  type WorkflowRunRecord,
} from '../../workflowStore';
import { isUniqueViolation } from '../client';
import { json, now } from '../sqlExpressions';
import type { Database, WorkflowRunTable, WorkflowTable } from '../types';

function toWorkflowRecord(row: Selectable<WorkflowTable>): WorkflowRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    manifest: parseStoredWorkflowManifest(row.manifest),
    status: row.status,
    webhook_token_hash: row.webhook_token_hash,
    next_run_at: row.next_run_at === null ? null : row.next_run_at.toISOString(),
    created_by_subject: CreatedBySubjectSchema.parse(row.created_by_subject),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function toRunRecord(row: Selectable<WorkflowRunTable>): WorkflowRunRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    status: row.status,
    trigger_type: row.trigger_type,
    input: row.input,
    manifest: parseStoredWorkflowManifest(row.manifest),
    steps: row.steps,
    error: row.error,
    created_by_subject: CreatedBySubjectSchema.parse(row.created_by_subject),
    created_at: row.created_at.toISOString(),
    finished_at: row.finished_at === null ? null : row.finished_at.toISOString(),
  };
}

export class PostgresWorkflowStore implements IWorkflowStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowRecord> {
    try {
      const row = await this.#db
        .insertInto('workflow')
        .values({
          id: newId(),
          tenant_id: input.tenant_id,
          name: input.name,
          manifest: json(input.manifest),
          status: input.manifest.status,
          webhook_token_hash: null,
          next_run_at: input.next_run_at,
          created_by_subject: json(input.created_by_subject),
          created_at: now(),
          updated_at: now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toWorkflowRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WorkflowNameConflictError(input.name, { cause: error });
      }
      throw error;
    }
  }

  async getWorkflow(input: WorkflowKey): Promise<WorkflowRecord | undefined> {
    const row = await this.#db
      .selectFrom('workflow')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toWorkflowRecord(row);
  }

  async getWorkflowById(input: { id: string }): Promise<WorkflowRecord | undefined> {
    const row = await this.#db.selectFrom('workflow').selectAll().where('id', '=', input.id).executeTakeFirst();
    return row === undefined ? undefined : toWorkflowRecord(row);
  }

  async getWorkflowByWebhookTokenHash(input: { webhook_token_hash: string }): Promise<WorkflowRecord | undefined> {
    const row = await this.#db
      .selectFrom('workflow')
      .selectAll()
      .where('webhook_token_hash', '=', input.webhook_token_hash)
      .executeTakeFirst();
    return row === undefined ? undefined : toWorkflowRecord(row);
  }

  async updateWorkflow(input: UpdateWorkflowInput): Promise<WorkflowRecord | undefined> {
    try {
      const row = await this.#db
        .updateTable('workflow')
        .set({
          name: input.name,
          manifest: json(input.manifest),
          status: input.manifest.status,
          next_run_at: input.next_run_at,
          updated_at: now(),
        })
        .where('tenant_id', '=', input.tenant_id)
        .where('id', '=', input.id)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toWorkflowRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WorkflowNameConflictError(input.name, { cause: error });
      }
      throw error;
    }
  }

  async setWebhookTokenHash(input: WorkflowKey & { webhook_token_hash: string }): Promise<void> {
    await this.#db
      .updateTable('workflow')
      .set({ webhook_token_hash: input.webhook_token_hash, updated_at: now() })
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .execute();
  }

  async deleteWorkflow(input: WorkflowKey): Promise<void> {
    await this.#db.deleteFrom('workflow').where('tenant_id', '=', input.tenant_id).where('id', '=', input.id).execute();
  }

  async listWorkflows(input: ListWorkflowsInput): Promise<{ data: WorkflowRecord[]; pagination: TokenPagination }> {
    const offset = decodeOffsetPageToken(input.page_token);
    let query = this.#db.selectFrom('workflow').selectAll().where('tenant_id', '=', input.tenant_id);
    if (input.created_by_subject_id !== undefined) {
      query = query.where(sql`created_by_subject->>'subject_id'`, '=', input.created_by_subject_id);
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(input.limit + 1)
      .offset(offset)
      .execute();
    const { data, pagination } = paginateOffsetRows(rows, input.limit, offset);
    return { data: data.map(toWorkflowRecord), pagination };
  }

  async listDueCronWorkflows(input: { until: Date; limit: number }): Promise<WorkflowRecord[]> {
    const rows = await this.#db
      .selectFrom('workflow')
      .selectAll()
      .where('status', '=', 'active')
      .where('next_run_at', '<=', input.until)
      .orderBy('next_run_at')
      .limit(input.limit)
      .execute();
    return rows.map(toWorkflowRecord);
  }

  async setNextRunAt(input: WorkflowKey & { next_run_at: Date | null }): Promise<void> {
    await this.#db
      .updateTable('workflow')
      .set({ next_run_at: input.next_run_at })
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .execute();
  }

  async createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunRecord> {
    const row = await this.#db
      .insertInto('workflow_run')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        workflow_id: input.workflow_id,
        status: 'running',
        trigger_type: input.trigger_type,
        input: json(input.input),
        manifest: json(input.manifest),
        steps: json([]),
        error: null,
        created_by_subject: json(input.created_by_subject),
        created_at: now(),
        finished_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRunRecord(row);
  }

  async getRun(input: { tenant_id: string; workflow_id: string; id: string }): Promise<WorkflowRunRecord | undefined> {
    const row = await this.#db
      .selectFrom('workflow_run')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('workflow_id', '=', input.workflow_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRunRecord(row);
  }

  async updateRun(input: UpdateWorkflowRunInput): Promise<void> {
    const patch: UpdateObject<Database, 'workflow_run'> = { steps: json(input.steps) };
    if (input.status !== undefined) {
      patch.status = input.status;
      if (input.status !== 'running') {
        patch.finished_at = now();
      }
    }
    if (input.error !== undefined) {
      patch.error = input.error;
    }
    await this.#db
      .updateTable('workflow_run')
      .set(patch)
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .execute();
  }

  async listRuns(input: ListWorkflowRunsInput): Promise<{ data: WorkflowRunRecord[]; pagination: TokenPagination }> {
    const offset = decodeOffsetPageToken(input.page_token);
    const rows = await this.#db
      .selectFrom('workflow_run')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('workflow_id', '=', input.workflow_id)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(input.limit + 1)
      .offset(offset)
      .execute();
    const { data, pagination } = paginateOffsetRows(rows, input.limit, offset);
    return { data: data.map(toRunRecord), pagination };
  }

  async countRunningRuns(input: { tenant_id: string; workflow_id: string }): Promise<number> {
    const row = await this.#db
      .selectFrom('workflow_run')
      .select(eb => eb.fn.countAll<string>().as('count'))
      .where('tenant_id', '=', input.tenant_id)
      .where('workflow_id', '=', input.workflow_id)
      .where('status', '=', 'running')
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async failStaleRuns(input: { before: Date; error: string }): Promise<number> {
    const result = await this.#db
      .updateTable('workflow_run')
      .set({ status: 'failed', error: input.error, finished_at: now() })
      .where('status', '=', 'running')
      .where('created_at', '<', input.before)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}
