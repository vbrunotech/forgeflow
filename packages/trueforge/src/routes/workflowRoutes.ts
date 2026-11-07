/**
 * Workflow route definitions. Handlers are registered in apis/workflows.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { PAGE_LIMIT } from '../schemas/common';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  CreateWorkflowRequestSchema,
  CreateWorkflowRunRequestSchema,
  CreateWorkflowWebhookTokenResponseSchema,
  DeleteWorkflowResponseSchema,
  ExecuteWorkflowCronRequestSchema,
  GetWorkflowResponseSchema,
  GetWorkflowRunResponseSchema,
  ListWorkflowRunsResponseSchema,
  ListWorkflowsResponseSchema,
  UpdateWorkflowRequestSchema,
  WorkflowWebhookResponseSchema,
} from '../schemas/workflow';
import { TOKEN_PAGINATION } from './fernExtensions';
import { OpenApiTag } from './openapiTags';

const errorContent = { 'application/json': { schema: RequestErrorResponseSchema } };

export const WorkflowIdParamsSchema = z.object({
  workflow_id: z.string().min(1).max(64).describe('Immutable workflow identifier.'),
});

export const WorkflowRunParamsSchema = z.object({
  workflow_id: z.string().min(1).max(64).describe('Immutable workflow identifier.'),
  run_id: z.string().min(1).max(64).describe('Immutable run identifier.'),
});

export const WorkflowWebhookParamsSchema = z.object({
  token: z.string().min(1).max(128).describe('Secret webhook token.'),
});

const paginationQueryShape = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT)
    .optional()
    .default(PAGE_LIMIT)
    .describe(`Page size. Defaults to ${String(PAGE_LIMIT)}`),
  page_token: z.string().optional().describe('Opaque token from a previous response `next_page_token`.'),
};

export const ListWorkflowsQuerySchema = z
  .object({
    ...paginationQueryShape,
    created_by_me: z
      .stringbool()
      .optional()
      .describe('When true, only workflows created by the authenticated subject.')
      .openapi({ type: 'boolean' }),
  })
  .openapi('ListWorkflowsQuery');

export const ListWorkflowRunsQuerySchema = z.object(paginationQueryShape).openapi('ListWorkflowRunsQuery');

export const listWorkflowsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.WORKFLOWS],
  summary: 'List workflows',
  description: 'List workflows the caller can manage, newest first.',
  'x-fern-sdk-group-name': ['workflows'],
  'x-fern-sdk-method-name': 'list',
  'x-fern-pagination': TOKEN_PAGINATION,
  request: { query: ListWorkflowsQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: ListWorkflowsResponseSchema } }, description: 'Workflows.' },
    400: { content: errorContent, description: 'Invalid query parameters or page token.' },
  },
});

export const createWorkflowRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.WORKFLOWS],
  summary: 'Create a workflow',
  description: 'Create a workflow from a graph of steps and a trigger.',
  'x-fern-sdk-group-name': ['workflows'],
  'x-fern-sdk-method-name': 'create',
  request: {
    body: { content: { 'application/json': { schema: CreateWorkflowRequestSchema } }, required: true },
  },
  responses: {
    201: { content: { 'application/json': { schema: GetWorkflowResponseSchema } }, description: 'Created workflow.' },
    400: { content: errorContent, description: 'Invalid graph or cron expression.' },
    404: { content: errorContent, description: 'A referenced agent was not found.' },
    409: { content: errorContent, description: 'The name is already taken.' },
  },
});

export const getWorkflowRoute = createRoute({
  method: 'get',
  path: '/{workflow_id}',
  tags: [OpenApiTag.WORKFLOWS],
  summary: 'Get a workflow',
  description: 'Get a workflow by id.',
  'x-fern-sdk-group-name': ['workflows'],
  'x-fern-sdk-method-name': 'get',
  request: { params: WorkflowIdParamsSchema },
  responses: {
    200: { content: { 'application/json': { schema: GetWorkflowResponseSchema } }, description: 'The workflow.' },
    403: { content: errorContent, description: 'The caller is not the creator or an admin.' },
    404: { content: errorContent, description: 'Not found.' },
  },
});

export const putWorkflowRoute = createRoute({
  method: 'put',
  path: '/{workflow_id}',
  tags: [OpenApiTag.WORKFLOWS],
  summary: 'Update a workflow',
  description: 'Replace the name and manifest. Runs already in progress keep the version they started with.',
  'x-fern-sdk-group-name': ['workflows'],
  'x-fern-sdk-method-name': 'update',
  request: {
    params: WorkflowIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateWorkflowRequestSchema } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: GetWorkflowResponseSchema } }, description: 'Updated workflow.' },
    400: { content: errorContent, description: 'Invalid graph or cron expression.' },
    403: { content: errorContent, description: 'The caller is not the creator or an admin.' },
    404: { content: errorContent, description: 'Workflow or referenced agent not found.' },
    409: { content: errorContent, description: 'The name is already taken.' },
  },
});

export const deleteWorkflowRoute = createRoute({
  method: 'delete',
  path: '/{workflow_id}',
  tags: [OpenApiTag.WORKFLOWS],
  summary: 'Delete a workflow',
  description: 'Delete a workflow and its run history. Idempotent.',
  'x-fern-sdk-group-name': ['workflows'],
  'x-fern-sdk-method-name': 'delete',
  request: { params: WorkflowIdParamsSchema },
  responses: {
    200: { content: { 'application/json': { schema: DeleteWorkflowResponseSchema } }, description: 'Deleted.' },
    403: { content: errorContent, description: 'The caller is not the creator or an admin.' },
  },
});

export const createWorkflowWebhookTokenRoute = createRoute({
  method: 'post',
  path: '/{workflow_id}/webhook-token',
  tags: [OpenApiTag.WORKFLOWS],
  summary: 'Issue a webhook token',
  description: 'Issue a webhook token, revoking any previous one. The token is only returned by this call.',
  'x-fern-sdk-group-name': ['workflows'],
  'x-fern-sdk-method-name': 'create_webhook_token',
  request: { params: WorkflowIdParamsSchema },
  responses: {
    201: {
      content: { 'application/json': { schema: CreateWorkflowWebhookTokenResponseSchema } },
      description: 'Issued token.',
    },
    400: { content: errorContent, description: 'The workflow does not have a webhook trigger.' },
    403: { content: errorContent, description: 'The caller is not the creator or an admin.' },
    404: { content: errorContent, description: 'Not found.' },
  },
});

export const createWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/{workflow_id}/runs',
  tags: [OpenApiTag.WORKFLOWS],
  summary: 'Run a workflow',
  description: 'Start a run now, whatever the trigger. Returns immediately; poll the run for progress.',
  'x-fern-sdk-group-name': ['workflows'],
  'x-fern-sdk-method-name': 'create_run',
  request: {
    params: WorkflowIdParamsSchema,
    body: { content: { 'application/json': { schema: CreateWorkflowRunRequestSchema } }, required: true },
  },
  responses: {
    201: { content: { 'application/json': { schema: GetWorkflowRunResponseSchema } }, description: 'Run started.' },
    403: { content: errorContent, description: 'The caller is not the creator or an admin.' },
    404: { content: errorContent, description: 'Workflow or referenced agent not found.' },
    429: { content: errorContent, description: 'Too many runs of this workflow are in progress.' },
  },
});

export const listWorkflowRunsRoute = createRoute({
  method: 'get',
  path: '/{workflow_id}/runs',
  tags: [OpenApiTag.WORKFLOWS],
  summary: 'List runs of a workflow',
  description: 'List runs of a workflow, newest first.',
  'x-fern-sdk-group-name': ['workflows'],
  'x-fern-sdk-method-name': 'list_runs',
  'x-fern-pagination': TOKEN_PAGINATION,
  request: { params: WorkflowIdParamsSchema, query: ListWorkflowRunsQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: ListWorkflowRunsResponseSchema } }, description: 'Runs.' },
    400: { content: errorContent, description: 'Invalid query parameters or page token.' },
    403: { content: errorContent, description: 'The caller is not the creator or an admin.' },
    404: { content: errorContent, description: 'Not found.' },
  },
});

export const getWorkflowRunRoute = createRoute({
  method: 'get',
  path: '/{workflow_id}/runs/{run_id}',
  tags: [OpenApiTag.WORKFLOWS],
  summary: 'Get a workflow run',
  description: 'Get one run with the status and output of each step.',
  'x-fern-sdk-group-name': ['workflows'],
  'x-fern-sdk-method-name': 'get_run',
  request: { params: WorkflowRunParamsSchema },
  responses: {
    200: { content: { 'application/json': { schema: GetWorkflowRunResponseSchema } }, description: 'The run.' },
    403: { content: errorContent, description: 'The caller is not the creator or an admin.' },
    404: { content: errorContent, description: 'Not found.' },
  },
});

export const invokeWorkflowWebhookRoute = createRoute({
  method: 'post',
  path: '/{token}',
  tags: [OpenApiTag.WORKFLOWS],
  summary: 'Invoke a workflow webhook',
  description: 'Start a run from an external system. The body is exposed to templates as `trigger.body`.',
  'x-fern-sdk-group-name': ['workflows'],
  'x-fern-sdk-method-name': 'invoke_webhook',
  'x-excluded': true,
  request: { params: WorkflowWebhookParamsSchema },
  responses: {
    202: { content: { 'application/json': { schema: WorkflowWebhookResponseSchema } }, description: 'Run started.' },
    404: { content: errorContent, description: 'Unknown token.' },
    409: { content: errorContent, description: 'The workflow is paused or no longer has a webhook trigger.' },
    429: { content: errorContent, description: 'Too many runs of this workflow are in progress.' },
  },
});

export const executeWorkflowCronRoute = createRoute({
  method: 'post',
  path: '/runs/execute',
  tags: [OpenApiTag.INTERNAL],
  summary: 'Execute a cron-triggered workflow run',
  description: 'Start a run of a due cron workflow.',
  'x-fern-sdk-group-name': ['internal', 'workflows'],
  'x-fern-sdk-method-name': 'execute_cron',
  'x-excluded': true,
  request: {
    body: { content: { 'application/json': { schema: ExecuteWorkflowCronRequestSchema } }, required: true },
  },
  responses: {
    204: { description: 'Run started, or skipped because the workflow is paused or busy.' },
    401: { content: errorContent, description: 'Invalid service credential.' },
    404: { content: errorContent, description: 'Not found.' },
  },
});
