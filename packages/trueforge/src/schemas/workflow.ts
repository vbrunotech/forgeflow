import { z } from '@hono/zod-openapi';
import { CreatedBySubjectSchema, TokenPaginationSchema } from '@truefoundry/trueforge-core/agent-session';
import { NameSchema } from './common';
import { CronExpressionSchema, TimezoneSchema } from './schedule';

/** Dispatch ticks every 30s, so a tighter cron could not be honoured. */
export const WORKFLOW_MIN_INTERVAL_SECONDS = 60;
export const WORKFLOW_MAX_NODES = 50;

const IsoTimestamp = z.iso.datetime().openapi({ type: 'string', format: 'date-time' });
const NullableIsoTimestamp = z.iso
  .datetime()
  .nullable()
  .openapi({ type: ['string', 'null'], format: 'date-time' });

export const WorkflowStatusSchema = z.enum(['active', 'paused']).openapi('WorkflowStatus');

export const WorkflowTriggerManualSchema = z
  .object({ type: z.literal('manual') })
  .strict()
  .openapi('WorkflowTriggerManual');

export const WorkflowTriggerCronSchema = z
  .object({
    type: z.literal('cron'),
    cron: CronExpressionSchema,
    timezone: TimezoneSchema.default('UTC'),
  })
  .strict()
  .openapi('WorkflowTriggerCron');

export const WorkflowTriggerWebhookSchema = z
  .object({ type: z.literal('webhook') })
  .strict()
  .openapi('WorkflowTriggerWebhook');

export const WorkflowTriggerSchema = z
  .discriminatedUnion('type', [WorkflowTriggerManualSchema, WorkflowTriggerCronSchema, WorkflowTriggerWebhookSchema])
  .openapi('WorkflowTrigger');

export const WORKFLOW_MAX_TRIGGERS = 10;

/** Identifier form so a node can be addressed from templates as `nodes.<id>.output`. */
export const WorkflowNodeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'must start with a lowercase letter and use only lowercase letters, digits, or _')
  .describe('Node id, unique in the workflow. Templates address it as `nodes.<id>.output`.')
  .openapi('WorkflowNodeId');

export const WorkflowNodePositionSchema = z
  .object({ x: z.number(), y: z.number() })
  .strict()
  .openapi('WorkflowNodePosition');

export const WorkflowNodeOnErrorSchema = z
  .enum(['stop', 'continue'])
  .describe('`stop` fails the run on error. `continue` records the error and proceeds to the next nodes.')
  .openapi('WorkflowNodeOnError');

const workflowNodeBaseShape = {
  id: WorkflowNodeIdSchema,
  name: z.string().trim().min(1).max(120).describe('Display label.'),
  position: WorkflowNodePositionSchema,
  on_error: WorkflowNodeOnErrorSchema.default('stop'),
};

export const WorkflowHttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).openapi('WorkflowHttpMethod');

export const WorkflowHttpRequestNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('http_request'),
    method: WorkflowHttpMethodSchema.default('GET'),
    url: z.string().trim().min(1).describe('Request URL. Supports `{{ }}` templates.'),
    headers: z.record(z.string(), z.string()).default({}).describe('Request headers. Values support templates.'),
    body: z.string().optional().describe('Raw request body. Supports templates.'),
    timeout_seconds: z.number().int().min(1).max(300).default(30),
  })
  .strict()
  .openapi('WorkflowHttpRequestNode');

export const WorkflowTransformNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('transform'),
    values: z
      .record(z.string(), z.string())
      .describe('Output object. Each value is a template; a value that is only one template keeps its JSON type.'),
  })
  .strict()
  .openapi('WorkflowTransformNode');

export const WorkflowConditionOperatorSchema = z
  .enum(['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'])
  .openapi('WorkflowConditionOperator');

export const WorkflowConditionNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('condition'),
    left: z.string().describe('Left operand. Supports templates.'),
    operator: WorkflowConditionOperatorSchema,
    right: z.string().default('').describe('Right operand. Ignored by `is_empty` and `is_not_empty`.'),
  })
  .strict()
  .openapi('WorkflowConditionNode');

/** Path inside each list item, e.g. `user.email`. Empty means the item itself. */
const ItemFieldSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^$|^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, 'use dot-separated keys, e.g. user.email')
  .default('');

/** Template for the list a data step works on. Empty means the previous step's output. */
const ListInputSchema = z
  .string()
  .default('')
  .describe('Template resolving to a list. Empty uses the previous step output.');

export const WORKFLOW_SWITCH_MAX_RULES = 10;
export const WORKFLOW_WAIT_MAX_SECONDS = 15 * 60;

export const WorkflowSwitchRuleSchema = z
  .object({ operator: WorkflowConditionOperatorSchema, right: z.string().default('') })
  .strict()
  .openapi('WorkflowSwitchRule');

export const WorkflowSwitchNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('switch'),
    value: z.string().describe('Value to route on. Supports templates.'),
    rules: z
      .array(WorkflowSwitchRuleSchema)
      .min(1)
      .max(WORKFLOW_SWITCH_MAX_RULES)
      .describe('Checked in order; the first match picks its branch, else `fallback`.'),
  })
  .strict()
  .openapi('WorkflowSwitchNode');

export const WorkflowMergeNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('merge'),
    mode: z
      .enum(['append', 'combine'])
      .default('append')
      .describe('`append` lists each incoming output; `combine` merges incoming objects into one.'),
  })
  .strict()
  .openapi('WorkflowMergeNode');

export const WorkflowWaitNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('wait'),
    seconds: z.number().int().min(1).max(WORKFLOW_WAIT_MAX_SECONDS),
  })
  .strict()
  .openapi('WorkflowWaitNode');

export const WorkflowStopAndErrorNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('stop_and_error'),
    message: z.string().trim().min(1).describe('Error message. Supports templates.'),
  })
  .strict()
  .openapi('WorkflowStopAndErrorNode');

export const WorkflowNoOpNodeSchema = z
  .object({ ...workflowNodeBaseShape, type: z.literal('no_op') })
  .strict()
  .openapi('WorkflowNoOpNode');

export const WorkflowFilterNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('filter'),
    input: ListInputSchema,
    field: ItemFieldSchema,
    operator: WorkflowConditionOperatorSchema,
    right: z.string().default(''),
  })
  .strict()
  .openapi('WorkflowFilterNode');

export const WorkflowSortNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('sort'),
    input: ListInputSchema,
    field: ItemFieldSchema,
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict()
  .openapi('WorkflowSortNode');

export const WorkflowLimitNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('limit'),
    input: ListInputSchema,
    max_items: z.number().int().min(1).max(10_000),
    keep: z.enum(['first', 'last']).default('first'),
  })
  .strict()
  .openapi('WorkflowLimitNode');

export const WorkflowRemoveDuplicatesNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('remove_duplicates'),
    input: ListInputSchema,
    field: ItemFieldSchema,
  })
  .strict()
  .openapi('WorkflowRemoveDuplicatesNode');

export const WorkflowSplitOutNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('split_out'),
    input: ListInputSchema,
    field: ItemFieldSchema.describe('List field inside each item whose entries become the output list.'),
  })
  .strict()
  .openapi('WorkflowSplitOutNode');

export const WorkflowAggregateNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('aggregate'),
    input: ListInputSchema,
    field: ItemFieldSchema,
    operation: z.enum(['collect', 'count', 'sum', 'average', 'min', 'max']).default('collect'),
  })
  .strict()
  .openapi('WorkflowAggregateNode');

export const WorkflowDateTimeUnitSchema = z
  .enum(['seconds', 'minutes', 'hours', 'days', 'weeks'])
  .openapi('WorkflowDateTimeUnit');

export const WorkflowDateTimeNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('date_time'),
    value: z.string().default('').describe('Date to start from. Supports templates. Empty means now.'),
    add_amount: z.number().int().min(-1_000_000).max(1_000_000).default(0),
    add_unit: WorkflowDateTimeUnitSchema.default('days'),
    timezone: TimezoneSchema.default('UTC'),
  })
  .strict()
  .openapi('WorkflowDateTimeNode');

export const WorkflowCryptoNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('crypto'),
    operation: z.enum(['hash', 'hmac', 'uuid']),
    algorithm: z.enum(['md5', 'sha1', 'sha256', 'sha512']).default('sha256'),
    encoding: z.enum(['hex', 'base64']).default('hex'),
    value: z.string().default('').describe('Text to hash. Supports templates.'),
    secret: z.string().default('').describe('HMAC key. Supports templates. Stored in plain text.'),
  })
  .strict()
  .openapi('WorkflowCryptoNode');

export const WorkflowAgentNodeSchema = z
  .object({
    ...workflowNodeBaseShape,
    type: z.literal('agent'),
    agent_name: NameSchema,
    task: z.string().trim().min(1).describe('First user message sent to the agent. Supports templates.'),
  })
  .strict()
  .openapi('WorkflowAgentNode');

export const WorkflowNodeSchema = z
  .discriminatedUnion('type', [
    WorkflowHttpRequestNodeSchema,
    WorkflowTransformNodeSchema,
    WorkflowConditionNodeSchema,
    WorkflowAgentNodeSchema,
    WorkflowSwitchNodeSchema,
    WorkflowMergeNodeSchema,
    WorkflowWaitNodeSchema,
    WorkflowStopAndErrorNodeSchema,
    WorkflowNoOpNodeSchema,
    WorkflowFilterNodeSchema,
    WorkflowSortNodeSchema,
    WorkflowLimitNodeSchema,
    WorkflowRemoveDuplicatesNodeSchema,
    WorkflowSplitOutNodeSchema,
    WorkflowAggregateNodeSchema,
    WorkflowDateTimeNodeSchema,
    WorkflowCryptoNodeSchema,
  ])
  .openapi('WorkflowNode');

export const WorkflowEdgeBranchSchema = z
  .string()
  .regex(/^(true|false|fallback|[0-9])$/)
  .describe(
    'Required on edges leaving a condition (`true`/`false`) or switch (rule index or `fallback`); not allowed elsewhere.',
  )
  .openapi('WorkflowEdgeBranch');

export const WorkflowEdgeSchema = z
  .object({
    source: WorkflowNodeIdSchema,
    target: WorkflowNodeIdSchema,
    branch: WorkflowEdgeBranchSchema.optional(),
  })
  .strict()
  .openapi('WorkflowEdge');

export const WorkflowManifestSchema = z
  .object({
    description: z.string().trim().max(500).default(''),
    status: WorkflowStatusSchema.default('active'),
    triggers: z
      .array(WorkflowTriggerSchema)
      .min(1)
      .max(WORKFLOW_MAX_TRIGGERS)
      .describe('Any of these starts a run. Several schedules are allowed; at most one manual and one webhook.'),
    nodes: z.array(WorkflowNodeSchema).min(1).max(WORKFLOW_MAX_NODES),
    edges: z.array(WorkflowEdgeSchema).default([]),
  })
  .strict()
  .openapi('WorkflowManifest');

export const WorkflowSchema = z
  .object({
    id: z.string(),
    name: NameSchema,
    manifest: WorkflowManifestSchema,
    webhook_configured: z.boolean().describe('Whether a webhook token has been issued.'),
    next_run_at: NullableIsoTimestamp,
    created_by_subject: CreatedBySubjectSchema,
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  })
  .strict()
  .openapi('Workflow');

export const CreateWorkflowRequestSchema = z
  .object({ name: NameSchema, manifest: WorkflowManifestSchema })
  .strict()
  .openapi('CreateWorkflowRequest');

export const UpdateWorkflowRequestSchema = z
  .object({ name: NameSchema, manifest: WorkflowManifestSchema })
  .strict()
  .openapi('UpdateWorkflowRequest');

export const GetWorkflowResponseSchema = z.object({ data: WorkflowSchema }).openapi('GetWorkflowResponse');
export const ListWorkflowsResponseSchema = z
  .object({ data: z.array(WorkflowSchema), pagination: TokenPaginationSchema })
  .openapi('ListWorkflowsResponse');
export const DeleteWorkflowResponseSchema = z.object({}).openapi('DeleteWorkflowResponse');

export const WorkflowWebhookTokenSchema = z
  .object({
    token: z.string().describe('Secret shown once. Issuing a new one revokes the previous token.'),
    path: z.string().describe('Path to POST to, relative to the server base URL.'),
  })
  .strict()
  .openapi('WorkflowWebhookToken');

export const CreateWorkflowWebhookTokenResponseSchema = z
  .object({ data: WorkflowWebhookTokenSchema })
  .openapi('CreateWorkflowWebhookTokenResponse');

export const WorkflowRunStatusSchema = z.enum(['running', 'succeeded', 'failed']).openapi('WorkflowRunStatus');
export const WorkflowRunTriggerTypeSchema = z.enum(['manual', 'cron', 'webhook']).openapi('WorkflowRunTriggerType');
export const WorkflowStepStatusSchema = z
  .enum(['pending', 'running', 'succeeded', 'failed', 'skipped'])
  .openapi('WorkflowStepStatus');

export const WorkflowRunStepSchema = z
  .object({
    node_id: WorkflowNodeIdSchema,
    status: WorkflowStepStatusSchema,
    output: z.unknown().describe('Step output, or null. Large outputs are truncated.'),
    error: z.string().nullable(),
    session_id: z.string().nullable().describe('Agent session for agent steps.'),
    started_at: NullableIsoTimestamp,
    finished_at: NullableIsoTimestamp,
  })
  .strict()
  .openapi('WorkflowRunStep');

export const WorkflowRunSchema = z
  .object({
    id: z.string(),
    workflow_id: z.string(),
    status: WorkflowRunStatusSchema,
    trigger_type: WorkflowRunTriggerTypeSchema,
    input: z.record(z.string(), z.unknown()).describe('Values exposed to templates as `trigger`.'),
    manifest: WorkflowManifestSchema,
    steps: z.array(WorkflowRunStepSchema),
    error: z.string().nullable(),
    created_by_subject: CreatedBySubjectSchema,
    created_at: IsoTimestamp,
    finished_at: NullableIsoTimestamp,
  })
  .strict()
  .openapi('WorkflowRun');

export const CreateWorkflowRunRequestSchema = z
  .object({
    input: z.record(z.string(), z.unknown()).default({}).describe('Exposed to templates as `trigger.body`.'),
  })
  .strict()
  .openapi('CreateWorkflowRunRequest');

export const GetWorkflowRunResponseSchema = z.object({ data: WorkflowRunSchema }).openapi('GetWorkflowRunResponse');
export const ListWorkflowRunsResponseSchema = z
  .object({ data: z.array(WorkflowRunSchema), pagination: TokenPaginationSchema })
  .openapi('ListWorkflowRunsResponse');

export const WorkflowWebhookAcceptedSchema = z
  .object({ run_id: z.string() })
  .strict()
  .openapi('WorkflowWebhookAccepted');
export const WorkflowWebhookResponseSchema = z
  .object({ data: WorkflowWebhookAcceptedSchema })
  .openapi('WorkflowWebhookResponse');

export const ExecuteWorkflowCronRequestSchema = z
  .object({
    workflow_id: z.string().min(1).max(64),
    scheduled_for: z.iso.datetime(),
  })
  .strict()
  .openapi('ExecuteWorkflowCronRequest');

export type WorkflowManifest = z.infer<typeof WorkflowManifestSchema>;
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export type WorkflowHttpRequestNode = z.infer<typeof WorkflowHttpRequestNodeSchema>;
export type WorkflowAgentNode = z.infer<typeof WorkflowAgentNodeSchema>;
export type WorkflowConditionNode = z.infer<typeof WorkflowConditionNodeSchema>;
export type WorkflowConditionOperator = z.infer<typeof WorkflowConditionOperatorSchema>;
export type WorkflowWaitNode = z.infer<typeof WorkflowWaitNodeSchema>;
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowRunTriggerType = z.infer<typeof WorkflowRunTriggerTypeSchema>;
export type WorkflowRunStep = z.infer<typeof WorkflowRunStepSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
