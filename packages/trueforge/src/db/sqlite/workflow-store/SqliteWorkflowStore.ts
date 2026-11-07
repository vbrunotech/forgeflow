import {
  CreatedBySubjectSchema,
  type CreatedBySubject,
  type TokenPagination,
} from '@truefoundry/trueforge-core/agent-session';
import {
  decodeOffsetPageToken,
  paginateOffsetRows,
} from '@truefoundry/trueforge-core/agent-session/store/OffsetPageToken';
import { sql, type ExpressionBuilder, type Kysely, type UpdateObject } from 'kysely';
import type {
  WorkflowManifest,
  WorkflowRunStatus,
  WorkflowRunStep,
  WorkflowRunTriggerType,
  WorkflowStatus,
} from '../../../schemas/workflow';
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
import { jsonbBind, jsonText, nowIso } from '../sqlExpressions';
import type { Database } from '../types';

function workflowColumns(eb: ExpressionBuilder<Database, 'workflow'>) {
  return [
    'id' as const,
    'tenant_id' as const,
    'name' as const,
    jsonText<WorkflowManifest>(eb.ref('manifest')).as('manifest'),
    'status' as const,
    'webhook_token_hash' as const,
    'next_run_at' as const,
    jsonText<CreatedBySubject>(eb.ref('created_by_subject')).as('created_by_subject'),
    'created_at' as const,
    'updated_at' as const,
  ];
}

function runColumns(eb: ExpressionBuilder<Database, 'workflow_run'>) {
  return [
    'id' as const,
    'tenant_id' as const,
    'workflow_id' as const,
    'status' as const,
    'trigger_type' as const,
    jsonText<Record<string, unknown>>(eb.ref('input')).as('input'),
    jsonText<WorkflowManifest>(eb.ref('manifest')).as('manifest'),
    jsonText<WorkflowRunStep[]>(eb.ref('steps')).as('steps'),
    'error' as const,
    jsonText<CreatedBySubject>(eb.ref('created_by_subject')).as('created_by_subject'),
    'created_at' as const,
    'finished_at' as const,
  ];
}

interface WorkflowRow {
  id: string;
  tenant_id: string;
  name: string;
  manifest: WorkflowManifest;
  status: WorkflowStatus;
  webhook_token_hash: string | null;
  next_run_at: string | null;
  created_by_subject: CreatedBySubject;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  status: WorkflowRunStatus;
  trigger_type: WorkflowRunTriggerType;
  input: Record<string, unknown>;
  manifest: WorkflowManifest;
  steps: WorkflowRunStep[];
  error: string | null;
  created_by_subject: CreatedBySubject;
  created_at: string;
  finished_at: string | null;
}

function toWorkflowRecord(row: WorkflowRow): WorkflowRecord {
  return {
    ...row,
    manifest: parseStoredWorkflowManifest(row.manifest),
    created_by_subject: CreatedBySubjectSchema.parse(row.created_by_subject),
  };
}

function toRunRecord(row: RunRow): WorkflowRunRecord {
  return {
    ...row,
    manifest: parseStoredWorkflowManifest(row.manifest),
    created_by_subject: CreatedBySubjectSchema.parse(row.created_by_subject),
  };
}

export class SqliteWorkflowStore implements IWorkflowStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowRecord> {
    const timestamp = nowIso();
    try {
      const row = await this.#db
        .insertInto('workflow')
        .values({
          id: newId(),
          tenant_id: input.tenant_id,
          name: input.name,
          manifest: jsonbBind(input.manifest),
          status: input.manifest.status,
          webhook_token_hash: null,
          next_run_at: input.next_run_at?.toISOString() ?? null,
          created_by_subject: jsonbBind(input.created_by_subject),
          created_at: timestamp,
          updated_at: timestamp,
        })
        .returning(workflowColumns)
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
      .select(workflowColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toWorkflowRecord(row);
  }

  async getWorkflowById(input: { id: string }): Promise<WorkflowRecord | undefined> {
    const row = await this.#db
      .selectFrom('workflow')
      .select(workflowColumns)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toWorkflowRecord(row);
  }

  async getWorkflowByWebhookTokenHash(input: { webhook_token_hash: string }): Promise<WorkflowRecord | undefined> {
    const row = await this.#db
      .selectFrom('workflow')
      .select(workflowColumns)
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
          manifest: jsonbBind(input.manifest),
          status: input.manifest.status,
          next_run_at: input.next_run_at?.toISOString() ?? null,
          updated_at: nowIso(),
        })
        .where('tenant_id', '=', input.tenant_id)
        .where('id', '=', input.id)
        .returning(workflowColumns)
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
      .set({ webhook_token_hash: input.webhook_token_hash, updated_at: nowIso() })
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .execute();
  }

  async deleteWorkflow(input: WorkflowKey): Promise<void> {
    await this.#db.deleteFrom('workflow').where('tenant_id', '=', input.tenant_id).where('id', '=', input.id).execute();
  }

  async listWorkflows(input: ListWorkflowsInput): Promise<{ data: WorkflowRecord[]; pagination: TokenPagination }> {
    const offset = decodeOffsetPageToken(input.page_token);
    let query = this.#db.selectFrom('workflow').select(workflowColumns).where('tenant_id', '=', input.tenant_id);
    if (input.created_by_subject_id !== undefined) {
      query = query.where(sql`json_extract(created_by_subject, '$.subject_id')`, '=', input.created_by_subject_id);
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
      .select(workflowColumns)
      .where('status', '=', 'active')
      .where('next_run_at', '<=', input.until.toISOString())
      .orderBy('next_run_at')
      .limit(input.limit)
      .execute();
    return rows.map(toWorkflowRecord);
  }

  async setNextRunAt(input: WorkflowKey & { next_run_at: Date | null }): Promise<void> {
    await this.#db
      .updateTable('workflow')
      .set({ next_run_at: input.next_run_at?.toISOString() ?? null })
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
        input: jsonbBind(input.input),
        manifest: jsonbBind(input.manifest),
        steps: jsonbBind([]),
        error: null,
        created_by_subject: jsonbBind(input.created_by_subject),
        created_at: nowIso(),
        finished_at: null,
      })
      .returning(runColumns)
      .executeTakeFirstOrThrow();
    return toRunRecord(row);
  }

  async getRun(input: { tenant_id: string; workflow_id: string; id: string }): Promise<WorkflowRunRecord | undefined> {
    const row = await this.#db
      .selectFrom('workflow_run')
      .select(runColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('workflow_id', '=', input.workflow_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRunRecord(row);
  }

  async updateRun(input: UpdateWorkflowRunInput): Promise<void> {
    const patch: UpdateObject<Database, 'workflow_run'> = { steps: jsonbBind(input.steps) };
    if (input.status !== undefined) {
      patch.status = input.status;
      if (input.status !== 'running') {
        patch.finished_at = nowIso();
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
      .select(runColumns)
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
      .select(eb => eb.fn.countAll<number>().as('count'))
      .where('tenant_id', '=', input.tenant_id)
      .where('workflow_id', '=', input.workflow_id)
      .where('status', '=', 'running')
      .executeTakeFirstOrThrow();
    return row.count;
  }

  async failStaleRuns(input: { before: Date; error: string }): Promise<number> {
    const result = await this.#db
      .updateTable('workflow_run')
      .set({ status: 'failed', error: input.error, finished_at: nowIso() })
      .where('status', '=', 'running')
      .where('created_at', '<', input.before.toISOString())
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}
