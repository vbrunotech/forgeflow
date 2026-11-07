import type { CreatedBySubject, TokenPagination } from '@truefoundry/trueforge-core/agent-session';
import {
  WorkflowManifestSchema,
  type WorkflowManifest,
  type WorkflowRunStatus,
  type WorkflowRunStep,
  type WorkflowRunTriggerType,
  type WorkflowStatus,
} from '../schemas/workflow';

export interface WorkflowRecord {
  id: string;
  tenant_id: string;
  /** Unique per tenant. */
  name: string;
  manifest: WorkflowManifest;
  status: WorkflowStatus;
  /** Only the hash is stored; the token itself is shown once. */
  webhook_token_hash: string | null;
  /** Next cron trigger; null unless the workflow is active with a cron trigger. */
  next_run_at: string | null;
  created_by_subject: CreatedBySubject;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunRecord {
  id: string;
  tenant_id: string;
  workflow_id: string;
  status: WorkflowRunStatus;
  trigger_type: WorkflowRunTriggerType;
  input: Record<string, unknown>;
  /** Snapshot taken at trigger time, so editing a workflow cannot change a run in flight. */
  manifest: WorkflowManifest;
  steps: WorkflowRunStep[];
  error: string | null;
  created_by_subject: CreatedBySubject;
  created_at: string;
  finished_at: string | null;
}

/** Workflows saved before multiple triggers stored a single `trigger`; read it as a one-item list. */
function upgradeStoredManifest(manifest: unknown): unknown {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return manifest;
  }
  const { trigger, triggers, ...rest } = Object.fromEntries(Object.entries(manifest));
  if (trigger === undefined || triggers !== undefined) {
    return manifest;
  }
  return { ...rest, triggers: [trigger] };
}

export function parseStoredWorkflowManifest(manifest: unknown): WorkflowManifest {
  return WorkflowManifestSchema.parse(upgradeStoredManifest(manifest));
}

/** Name already taken in this tenant. */
export class WorkflowNameConflictError extends Error {
  constructor(name: string, options?: ErrorOptions) {
    super(`Workflow name already exists: ${name}`, options);
    this.name = 'WorkflowNameConflictError';
  }
}

export interface CreateWorkflowInput {
  tenant_id: string;
  name: string;
  manifest: WorkflowManifest;
  next_run_at: Date | null;
  created_by_subject: CreatedBySubject;
}

export interface UpdateWorkflowInput {
  tenant_id: string;
  id: string;
  name: string;
  manifest: WorkflowManifest;
  next_run_at: Date | null;
}

export interface WorkflowKey {
  tenant_id: string;
  id: string;
}

export interface ListWorkflowsInput {
  tenant_id: string;
  limit: number;
  page_token: string | undefined;
  /** When set, only workflows created by this subject. */
  created_by_subject_id: string | undefined;
}

export interface CreateWorkflowRunInput {
  tenant_id: string;
  workflow_id: string;
  trigger_type: WorkflowRunTriggerType;
  input: Record<string, unknown>;
  manifest: WorkflowManifest;
  created_by_subject: CreatedBySubject;
}

export interface UpdateWorkflowRunInput {
  tenant_id: string;
  id: string;
  steps: WorkflowRunStep[];
  /** Setting a terminal status also stamps `finished_at`. */
  status?: WorkflowRunStatus;
  error?: string | null;
}

export interface ListWorkflowRunsInput {
  tenant_id: string;
  workflow_id: string;
  limit: number;
  page_token: string | undefined;
}

export interface IWorkflowStore {
  createWorkflow(input: CreateWorkflowInput): Promise<WorkflowRecord>;
  getWorkflow(input: WorkflowKey): Promise<WorkflowRecord | undefined>;
  /** Internal lookup when the id is the only trusted input. */
  getWorkflowById(input: { id: string }): Promise<WorkflowRecord | undefined>;
  getWorkflowByWebhookTokenHash(input: { webhook_token_hash: string }): Promise<WorkflowRecord | undefined>;
  /** Returns undefined when the workflow is gone. */
  updateWorkflow(input: UpdateWorkflowInput): Promise<WorkflowRecord | undefined>;
  setWebhookTokenHash(input: WorkflowKey & { webhook_token_hash: string }): Promise<void>;
  /** Idempotent; runs cascade. */
  deleteWorkflow(input: WorkflowKey): Promise<void>;
  listWorkflows(input: ListWorkflowsInput): Promise<{ data: WorkflowRecord[]; pagination: TokenPagination }>;

  /** Active cron workflows with `next_run_at <= until`, oldest first. */
  listDueCronWorkflows(input: { until: Date; limit: number }): Promise<WorkflowRecord[]>;
  setNextRunAt(input: WorkflowKey & { next_run_at: Date | null }): Promise<void>;

  createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunRecord>;
  getRun(input: { tenant_id: string; workflow_id: string; id: string }): Promise<WorkflowRunRecord | undefined>;
  updateRun(input: UpdateWorkflowRunInput): Promise<void>;
  /** Newest first. */
  listRuns(input: ListWorkflowRunsInput): Promise<{ data: WorkflowRunRecord[]; pagination: TokenPagination }>;
  countRunningRuns(input: { tenant_id: string; workflow_id: string }): Promise<number>;
  /** Fails `running` rows created before `before` (their process died). Returns how many. */
  failStaleRuns(input: { before: Date; error: string }): Promise<number>;
}
