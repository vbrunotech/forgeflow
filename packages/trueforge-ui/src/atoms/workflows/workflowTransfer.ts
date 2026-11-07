import type {
  WorkflowAggregateOperation,
  WorkflowConditionOperator,
  WorkflowCryptoNode,
  WorkflowDateTimeUnit,
  WorkflowEdge,
  WorkflowManifest,
  WorkflowNode,
  WorkflowNodeBase,
  WorkflowSwitchRule,
  WorkflowTrigger,
} from '../../server/types.js';
import { canAddTrigger, renameNodeId, type WorkflowDraft } from './workflowDraft.js';
import {
  isObject,
  layoutSteps,
  sanitizeWorkflowJson,
  text,
  toStepId,
  toWorkflowName,
  type JsonObject,
} from './workflowSanitize.js';

/** Marks a Forgeflow export so it is not mistaken for some other JSON. */
export const FORGEFLOW_FORMAT = 'forgeflow.workflow';
const FORGEFLOW_FORMAT_VERSION = 1;
const MAX_STEPS = 50;
/** n8n nodes are small squares about 220px apart; ours are wider, so spread imported layouts out. */
const N8N_SPREAD = 1.4;

export type WorkflowFileFormat = 'forgeflow' | 'n8n';

export type WorkflowImport = {
  format: WorkflowFileFormat;
  draft: WorkflowDraft;
  /** What did not carry over exactly, in plain words for the person importing. */
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Forgeflow format: an exact copy of the editor draft.
// ---------------------------------------------------------------------------

export function exportForgeflowJson(draft: WorkflowDraft): string {
  const { description, triggers, nodes, edges } = draft.manifest;
  return JSON.stringify(
    {
      format: FORGEFLOW_FORMAT,
      version: FORGEFLOW_FORMAT_VERSION,
      name: draft.name,
      description,
      triggers,
      nodes,
      edges,
    },
    null,
    2,
  );
}

function importForgeflow(raw: JsonObject): WorkflowImport {
  const { draft, skippedSteps } = sanitizeWorkflowJson({ raw, keepLayout: true });
  return {
    format: 'forgeflow',
    draft,
    warnings: skippedSteps.map(name => `“${name}” uses a step type this version does not know, so it was left out.`),
  };
}

// ---------------------------------------------------------------------------
// n8n format: nodes + connections keyed by node name.
// ---------------------------------------------------------------------------

type N8nNode = {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: JsonObject;
  onError?: string;
};

type N8nConnection = { node: string; type: 'main'; index: number };

const N8N_CONDITION: Record<WorkflowConditionOperator, { type: string; operation: string; singleValue?: true }> = {
  equals: { type: 'string', operation: 'equals' },
  not_equals: { type: 'string', operation: 'notEquals' },
  contains: { type: 'string', operation: 'contains' },
  greater_than: { type: 'number', operation: 'gt' },
  less_than: { type: 'number', operation: 'lt' },
  is_empty: { type: 'string', operation: 'empty', singleValue: true },
  is_not_empty: { type: 'string', operation: 'notEmpty', singleValue: true },
};

/** v2 operations, plus the v1 names (`larger`, `isEmpty`…) older n8n exports still use. */
const FROM_N8N_OPERATION: Record<string, WorkflowConditionOperator> = {
  equals: 'equals',
  equal: 'equals',
  notEquals: 'not_equals',
  notEqual: 'not_equals',
  contains: 'contains',
  gt: 'greater_than',
  larger: 'greater_than',
  lt: 'less_than',
  smaller: 'less_than',
  empty: 'is_empty',
  isEmpty: 'is_empty',
  notEmpty: 'is_not_empty',
  isNotEmpty: 'is_not_empty',
};

const AGGREGATIONS: readonly WorkflowAggregateOperation[] = ['count', 'sum', 'average', 'min', 'max'];
const DATE_UNITS: readonly WorkflowDateTimeUnit[] = ['seconds', 'minutes', 'hours', 'days', 'weeks'];
const ALGORITHMS: readonly WorkflowCryptoNode['algorithm'][] = ['md5', 'sha1', 'sha256', 'sha512'];

function n8nId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/** n8n requires unique node names; ours may repeat. */
function uniqueNames(nodes: readonly WorkflowNode[], reserved: ReadonlySet<string>): Map<string, string> {
  const used = new Set(reserved);
  const names = new Map<string, string>();
  for (const node of nodes) {
    let name = node.name;
    for (let suffix = 2; used.has(name); suffix += 1) name = `${node.name} ${String(suffix)}`;
    used.add(name);
    names.set(node.id, name);
  }
  return names;
}

/** Node names sit inside `$('…')`, so their quotes and backslashes need escaping. */
function escapeN8nName(name: string): string {
  return name.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

const TEMPLATE = /\{\{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;

/** `{{ nodes.fetch.output.body }}` → `={{ $('Fetch').item.json.body }}`; plain text stays plain. */
function toN8nExpression({
  value,
  names,
  triggerName,
}: {
  value: string;
  names: ReadonlyMap<string, string>;
  triggerName: string;
}): string {
  let changed = false;
  const translated = value.replace(TEMPLATE, (match, path: string) => {
    const [root, ...rest] = path.split('.');
    let reference: string | null = null;
    if (root === 'trigger') {
      reference = `$('${escapeN8nName(triggerName)}').item.json${rest.map(segment => `.${segment}`).join('')}`;
    } else if (root === 'nodes' && rest[1] === 'output') {
      const name = names.get(rest[0] ?? '');
      if (name !== undefined) {
        reference = `$('${escapeN8nName(name)}').item.json${rest
          .slice(2)
          .map(segment => `.${segment}`)
          .join('')}`;
      }
    }
    if (reference == null) return match;
    changed = true;
    return `{{ ${reference} }}`;
  });
  return changed ? `=${translated}` : value;
}

function n8nConditions({
  left,
  operator,
  right,
}: {
  left: string;
  operator: WorkflowConditionOperator;
  right: string;
}) {
  const op = N8N_CONDITION[operator];
  return {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [
      {
        id: n8nId(),
        leftValue: left,
        rightValue: op.singleValue === true ? '' : right,
        operator: { type: op.type, operation: op.operation, ...(op.singleValue === true ? { singleValue: true } : {}) },
      },
    ],
    combinator: 'and',
  };
}

function cronToN8n(trigger: Extract<WorkflowTrigger, { type: 'cron' }>): JsonObject {
  return { rule: { interval: [{ field: 'cronExpression', expression: trigger.cron }] } };
}

function stepToN8n({
  node,
  expr,
}: {
  node: WorkflowNode;
  expr: (value: string) => string;
}): Pick<N8nNode, 'type' | 'typeVersion' | 'parameters'> {
  switch (node.type) {
    case 'http_request': {
      const headers = Object.entries(node.headers);
      return {
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        parameters: {
          method: node.method,
          url: expr(node.url),
          ...(headers.length > 0
            ? {
                sendHeaders: true,
                headerParameters: { parameters: headers.map(([name, value]) => ({ name, value: expr(value) })) },
              }
            : {}),
          ...(node.body !== undefined && node.body !== ''
            ? { sendBody: true, contentType: 'raw', rawContentType: 'application/json', body: expr(node.body) }
            : {}),
          options: { timeout: node.timeoutSeconds * 1000 },
        },
      };
    }
    case 'transform':
      return {
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        parameters: {
          assignments: {
            assignments: Object.entries(node.values).map(([name, value]) => ({
              id: n8nId(),
              name,
              value: expr(value),
              type: 'string',
            })),
          },
          options: {},
        },
      };
    case 'condition':
      return {
        type: 'n8n-nodes-base.if',
        typeVersion: 2,
        parameters: {
          conditions: n8nConditions({ left: expr(node.left), operator: node.operator, right: expr(node.right) }),
          options: {},
        },
      };
    case 'switch':
      return {
        type: 'n8n-nodes-base.switch',
        typeVersion: 3,
        parameters: {
          rules: {
            values: node.rules.map(rule => ({
              conditions: n8nConditions({ left: expr(node.value), operator: rule.operator, right: expr(rule.right) }),
            })),
          },
          options: { fallbackOutput: 'extra' },
        },
      };
    case 'merge':
      return {
        type: 'n8n-nodes-base.merge',
        typeVersion: 3,
        parameters: node.mode === 'append' ? { mode: 'append' } : { mode: 'combine', combineBy: 'combineByPosition' },
      };
    case 'wait':
      return {
        type: 'n8n-nodes-base.wait',
        typeVersion: 1.1,
        parameters: { amount: node.seconds, unit: 'seconds' },
      };
    case 'stop_and_error':
      return {
        type: 'n8n-nodes-base.stopAndError',
        typeVersion: 1,
        parameters: { errorMessage: expr(node.message) },
      };
    case 'no_op':
      return { type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} };
    case 'filter':
      return {
        type: 'n8n-nodes-base.filter',
        typeVersion: 2,
        parameters: {
          conditions: n8nConditions({
            left: node.field === '' ? '={{ $json }}' : `={{ $json.${node.field} }}`,
            operator: node.operator,
            right: expr(node.right),
          }),
          options: {},
        },
      };
    case 'sort':
      return {
        type: 'n8n-nodes-base.sort',
        typeVersion: 1,
        parameters: {
          sortFieldsUi: {
            sortField: [{ fieldName: node.field, order: node.order === 'asc' ? 'ascending' : 'descending' }],
          },
        },
      };
    case 'limit':
      return {
        type: 'n8n-nodes-base.limit',
        typeVersion: 1,
        parameters: { maxItems: node.maxItems, keep: node.keep === 'first' ? 'firstItems' : 'lastItems' },
      };
    case 'remove_duplicates':
      return {
        type: 'n8n-nodes-base.removeDuplicates',
        typeVersion: 1.1,
        parameters:
          node.field === '' ? { compare: 'allFields' } : { compare: 'selectedFields', fieldsToCompare: node.field },
      };
    case 'split_out':
      return { type: 'n8n-nodes-base.splitOut', typeVersion: 1, parameters: { fieldToSplitOut: node.field } };
    case 'aggregate':
      return node.operation === 'collect'
        ? {
            type: 'n8n-nodes-base.aggregate',
            typeVersion: 1,
            parameters: { fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: node.field }] }, options: {} },
          }
        : {
            type: 'n8n-nodes-base.summarize',
            typeVersion: 1,
            parameters: { fieldsToSummarize: { values: [{ aggregation: node.operation, field: node.field }] } },
          };
    case 'date_time':
      return {
        type: 'n8n-nodes-base.dateTime',
        typeVersion: 2,
        parameters:
          node.addAmount === 0
            ? { operation: 'getCurrentDate', options: { timezone: node.timezone } }
            : {
                operation: node.addAmount > 0 ? 'addToDate' : 'subtractFromDate',
                magnitude: node.value === '' ? '={{ $now }}' : expr(node.value),
                timeUnit: node.addUnit,
                duration: Math.abs(node.addAmount),
              },
      };
    case 'crypto':
      return {
        type: 'n8n-nodes-base.crypto',
        typeVersion: 1,
        parameters:
          node.operation === 'uuid'
            ? { action: 'generate', type: 'uuid' }
            : {
                action: node.operation,
                type: node.algorithm.toUpperCase(),
                value: expr(node.value),
                encoding: node.encoding,
                ...(node.operation === 'hmac' ? { secret: expr(node.secret) } : {}),
              },
      };
    case 'agent':
      return {
        type: '@n8n/n8n-nodes-langchain.agent',
        typeVersion: 1.7,
        parameters: { promptType: 'define', text: expr(node.task), options: {} },
      };
  }
}

const TRIGGER_N8N: Record<WorkflowTrigger['type'], { type: string; typeVersion: number; name: string }> = {
  manual: { type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, name: 'When clicking ‘Execute workflow’' },
  cron: { type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, name: 'Schedule Trigger' },
  webhook: { type: 'n8n-nodes-base.webhook', typeVersion: 2, name: 'Webhook' },
};

/** Output index n8n uses for a branch: If is true/false, Switch rules then the extra fallback. */
function outputIndex({ source, branch }: { source: WorkflowNode | undefined; branch: string | undefined }): number {
  if (branch === undefined || source === undefined) return 0;
  if (source.type === 'condition') return branch === 'false' ? 1 : 0;
  if (source.type === 'switch') return branch === 'fallback' ? source.rules.length : Number(branch);
  return 0;
}

export function exportN8nJson(draft: WorkflowDraft): string {
  const { triggers, nodes, edges } = draft.manifest;
  const triggerNames: string[] = [];
  const usedTriggerNames = new Set<string>();
  for (const trigger of triggers) {
    const base = TRIGGER_N8N[trigger.type].name;
    let name = base;
    for (let suffix = 2; usedTriggerNames.has(name); suffix += 1) name = `${base} ${String(suffix)}`;
    usedTriggerNames.add(name);
    triggerNames.push(name);
  }
  const names = uniqueNames(nodes, usedTriggerNames);
  const expr = (value: string) => toN8nExpression({ value, names, triggerName: triggerNames[0] ?? 'Trigger' });
  const minX = nodes.reduce((min, node) => Math.min(min, node.position.x), nodes[0]?.position.x ?? 0);
  const firstY = nodes[0]?.position.y ?? 0;

  const n8nNodes: N8nNode[] = [
    ...triggers.map((trigger, index) => ({
      id: n8nId(),
      name: triggerNames[index] ?? TRIGGER_N8N[trigger.type].name,
      type: TRIGGER_N8N[trigger.type].type,
      typeVersion: TRIGGER_N8N[trigger.type].typeVersion,
      position: [Math.round((minX - 360) / N8N_SPREAD), Math.round((firstY + index * 160) / N8N_SPREAD)] satisfies [
        number,
        number,
      ],
      parameters:
        trigger.type === 'cron'
          ? cronToN8n(trigger)
          : trigger.type === 'webhook'
            ? { httpMethod: 'POST', path: n8nId(), options: {} }
            : {},
    })),
    ...nodes.map(node => ({
      id: n8nId(),
      name: names.get(node.id) ?? node.name,
      position: [Math.round(node.position.x / N8N_SPREAD), Math.round(node.position.y / N8N_SPREAD)] satisfies [
        number,
        number,
      ],
      ...stepToN8n({ node, expr }),
      ...(node.onError === 'continue' ? { onError: 'continueRegularOutput' } : {}),
    })),
  ];

  const connections: Record<string, { main: N8nConnection[][] }> = {};
  const connect = ({ from, index, to }: { from: string; index: number; to: string }) => {
    const outputs = (connections[from] ??= { main: [] }).main;
    while (outputs.length <= index) outputs.push([]);
    outputs[index]?.push({ node: to, type: 'main', index: 0 });
  };
  const targets = new Set(edges.map(edge => edge.target));
  for (const name of triggerNames) {
    for (const node of nodes) {
      if (!targets.has(node.id)) connect({ from: name, index: 0, to: names.get(node.id) ?? node.name });
    }
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const edge of edges) {
    const from = names.get(edge.source);
    const to = names.get(edge.target);
    if (from === undefined || to === undefined) continue;
    connect({ from, index: outputIndex({ source: byId.get(edge.source), branch: edge.branch }), to });
  }

  return JSON.stringify(
    {
      name: draft.name,
      nodes: n8nNodes,
      connections,
      settings: { executionOrder: 'v1' },
      pinData: {},
      active: false,
    },
    null,
    2,
  );
}

// --- n8n import ---------------------------------------------------------------

type N8nImportNode = {
  name: string;
  type: string;
  parameters: JsonObject;
  position: { x: number; y: number };
  continueOnError: boolean;
};

function toN8nImportNode(raw: unknown): N8nImportNode | null {
  if (!isObject(raw) || typeof raw['name'] !== 'string' || typeof raw['type'] !== 'string') return null;
  const position = Array.isArray(raw['position']) ? raw['position'] : [];
  const [x, y] = position;
  return {
    name: raw['name'],
    type: raw['type'],
    parameters: isObject(raw['parameters']) ? raw['parameters'] : {},
    position: {
      x: typeof x === 'number' ? x * N8N_SPREAD : 0,
      y: typeof y === 'number' ? y * N8N_SPREAD : 0,
    },
    continueOnError:
      raw['continueOnFail'] === true || (typeof raw['onError'] === 'string' && raw['onError'].startsWith('continue')),
  };
}

function param(params: JsonObject, path: string): unknown {
  let current: unknown = params;
  for (const key of path.split('.')) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function n8nNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

const CRON_DEFAULT = '0 9 * * *';
const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** n8n's schedule rules → cron; one trigger per rule. Unknown rules fall back with a warning. */
function n8nScheduleToCrons({ params, warn }: { params: JsonObject; warn: (message: string) => void }): string[] {
  const rules = list(param(params, 'rule.interval'));
  if (rules.length === 0) return ['0 0 * * *'];
  return rules.map(rule => {
    if (!isObject(rule)) return CRON_DEFAULT;
    const minute = n8nNumber(rule['triggerAtMinute'], 0);
    const hour = n8nNumber(rule['triggerAtHour'], 0);
    switch (rule['field']) {
      case 'cronExpression':
        return text(rule['expression'], CRON_DEFAULT);
      case 'minutes':
        return `*/${String(n8nNumber(rule['minutesInterval'], 5))} * * * *`;
      case 'hours':
        return `${String(minute)} */${String(n8nNumber(rule['hoursInterval'], 1))} * * *`;
      case 'days':
        return `${String(minute)} ${String(hour)} */${String(n8nNumber(rule['daysInterval'], 1))} * *`;
      case 'weeks': {
        const days = list(rule['triggerAtDay']).map(day =>
          typeof day === 'number' ? day : (WEEKDAYS[text(day).toLowerCase()] ?? 1),
        );
        return `${String(minute)} ${String(hour)} * * ${days.length === 0 ? '1' : days.join(',')}`;
      }
      case 'months':
        return `${String(minute)} ${String(hour)} ${String(n8nNumber(rule['triggerAtDayOfMonth'], 1))} */${String(n8nNumber(rule['monthsInterval'], 1))} *`;
      default:
        warn(`A schedule rule (“${text(rule['field'], 'unknown')}”) was replaced by “every day at 09:00”. Check it.`);
        return CRON_DEFAULT;
    }
  });
}

type ExpressionContext = {
  /** n8n node name → Forgeflow step id; trigger names map to null (they become `trigger`). */
  nameToId: ReadonlyMap<string, string | null>;
  /** The step the current node reads `$json` from, or null for a trigger, undefined when ambiguous. */
  upstream: string | null | undefined;
  warn: (message: string) => void;
  nodeName: string;
};

// `$json…`, `$('Name').item.json…` (also `.first()` / `.last()`, either quote, escapes allowed), or `$node["Name"].json…`.
const N8N_REFERENCE =
  /^(?:\$json|\$\(\s*(?:'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)")\s*\)\.(?:item|first\(\)|last\(\))\.json|\$node\[\s*['"]([^'"]+)['"]\s*\]\.json)((?:\.[A-Za-z0-9_-]+|\[\s*['"][A-Za-z0-9_-]+['"]\s*\])*)$/;

/** One `{{ … }}` body → a Forgeflow path, or null when it is real JavaScript. */
function n8nReferenceToPath({ body, context }: { body: string; context: ExpressionContext }): string | null {
  const match = N8N_REFERENCE.exec(body.trim());
  if (match == null) return null;
  const quoted = match[1] ?? match[2];
  const named = quoted === undefined ? match[3] : quoted.replace(/\\(.)/g, '$1');
  const rest = (match[4] ?? '').replace(/\[\s*['"]([A-Za-z0-9_-]+)['"]\s*\]/g, '.$1');
  const source = named === undefined ? context.upstream : context.nameToId.get(named);
  if (source === undefined) return null;
  return source === null ? `trigger${rest}` : `nodes.${source}.output${rest}`;
}

/** `={{ $json.email }}` → `{{ nodes.prev.output.email }}`; JavaScript is kept and reported. */
function fromN8nValue({ value, context }: { value: unknown; context: ExpressionContext }): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return value == null ? '' : JSON.stringify(value);
  if (!value.startsWith('=')) return value;
  let untranslated = false;
  const translated = value.slice(1).replace(/\{\{([\s\S]*?)\}\}/g, (match, body: string) => {
    const path = n8nReferenceToPath({ body, context });
    if (path == null) {
      untranslated = true;
      return match;
    }
    return `{{ ${path} }}`;
  });
  if (untranslated) {
    context.warn(`“${context.nodeName}” has an n8n expression that could not be translated: ${value.slice(1, 80)}`);
  }
  return translated;
}

type ConditionParts = { left: string; operator: WorkflowConditionOperator; right: string };

/** First condition of an If/Filter/Switch rule, v2 shape or v1 (`conditions.string[0]`). */
function readCondition({
  conditions,
  context,
}: {
  conditions: unknown;
  context: ExpressionContext;
}): ConditionParts | null {
  if (!isObject(conditions)) return null;
  const v2 = list(conditions['conditions']);
  if (v2.length > 0) {
    if (v2.length > 1) context.warn(`“${context.nodeName}” has several conditions; only the first was kept.`);
    const first = v2[0];
    if (!isObject(first)) return null;
    const operation = text(param(first, 'operator.operation'));
    return {
      left: fromN8nValue({ value: first['leftValue'], context }),
      operator: FROM_N8N_OPERATION[operation] ?? 'equals',
      right: fromN8nValue({ value: first['rightValue'], context }),
    };
  }
  for (const kind of ['string', 'number', 'boolean', 'dateTime']) {
    const first = list(conditions[kind])[0];
    if (isObject(first)) {
      return {
        left: fromN8nValue({ value: first['value1'], context }),
        operator: FROM_N8N_OPERATION[text(first['operation'])] ?? 'equals',
        right: fromN8nValue({ value: first['value2'], context }),
      };
    }
  }
  return null;
}

/** `{{ $json.user.email }}` (n8n's per-item field) → `user.email`, for list steps. */
function itemField(value: unknown): string {
  const match = /^=?\{\{\s*\$json\.?([A-Za-z0-9_.-]*)\s*\}\}$/.exec(text(value).trim());
  return match?.[1] ?? text(value).replace(/^=/, '');
}

function fromN8nNode({
  node,
  base,
  context,
}: {
  node: N8nImportNode;
  base: WorkflowNodeBase;
  context: ExpressionContext;
}): WorkflowNode | null {
  const p = node.parameters;
  const value = (raw: unknown) => fromN8nValue({ value: raw, context });
  switch (node.type) {
    case 'n8n-nodes-base.httpRequest': {
      const headers = Object.fromEntries(
        list(param(p, 'headerParameters.parameters')).flatMap(header =>
          isObject(header) && typeof header['name'] === 'string' ? [[header['name'], value(header['value'])]] : [],
        ),
      );
      const bodyFields = list(param(p, 'bodyParameters.parameters')).flatMap(field =>
        isObject(field) && typeof field['name'] === 'string' ? [[field['name'], value(field['value'])]] : [],
      );
      const rawBody = p['jsonBody'] ?? p['body'];
      const body =
        rawBody !== undefined
          ? value(rawBody)
          : bodyFields.length > 0
            ? JSON.stringify(Object.fromEntries(bodyFields))
            : undefined;
      const method = text(p['method'], text(p['requestMethod'], 'GET')).toUpperCase();
      return {
        ...base,
        type: 'http_request',
        method: method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE' ? method : 'GET',
        url: value(p['url']),
        headers,
        ...(body === undefined ? {} : { body }),
        timeoutSeconds: Math.min(300, Math.max(1, Math.round(n8nNumber(param(p, 'options.timeout'), 30_000) / 1000))),
      };
    }
    case 'n8n-nodes-base.set': {
      const v3 = list(param(p, 'assignments.assignments'));
      const legacy = ['string', 'number', 'boolean'].flatMap(kind => list(param(p, `values.${kind}`)));
      const entries = (v3.length > 0 ? v3 : legacy).flatMap(entry =>
        isObject(entry) && typeof entry['name'] === 'string' ? [[entry['name'], value(entry['value'])]] : [],
      );
      return { ...base, type: 'transform', values: Object.fromEntries(entries) };
    }
    case 'n8n-nodes-base.if': {
      const condition = readCondition({ conditions: p['conditions'], context });
      return { ...base, type: 'condition', ...(condition ?? { left: '', operator: 'equals', right: '' }) };
    }
    case 'n8n-nodes-base.filter': {
      const condition = readCondition({ conditions: p['conditions'], context });
      // The field lives in the raw left value (`{{ $json.email }}`), before translation.
      const firstRaw = list(param(p, 'conditions.conditions'))[0];
      const left = isObject(firstRaw) ? firstRaw['leftValue'] : condition?.left;
      return {
        ...base,
        type: 'filter',
        input: '',
        field: itemField(left),
        operator: condition?.operator ?? 'is_not_empty',
        right: condition?.right ?? '',
      };
    }
    case 'n8n-nodes-base.switch': {
      const rules: WorkflowSwitchRule[] = [];
      let switchValue = '';
      for (const rule of list(param(p, 'rules.values')).slice(0, 10)) {
        const condition = isObject(rule) ? readCondition({ conditions: rule['conditions'], context }) : null;
        if (condition == null) continue;
        if (switchValue === '') switchValue = condition.left;
        else if (condition.left !== switchValue) {
          context.warn(`“${context.nodeName}” checks different values per rule; all rules now check the first one.`);
        }
        rules.push({ operator: condition.operator, right: condition.right });
      }
      if (rules.length === 0) {
        context.warn(`“${context.nodeName}” uses an older Switch format; set its rules again.`);
        rules.push({ operator: 'equals', right: '' });
      }
      return { ...base, type: 'switch', value: switchValue, rules };
    }
    case 'n8n-nodes-base.merge': {
      const mode = text(p['mode'], 'append');
      if (mode !== 'append' && mode !== 'combine') {
        context.warn(`“${context.nodeName}” used Merge mode “${mode}”; it now appends.`);
      }
      return { ...base, type: 'merge', mode: mode === 'combine' ? 'combine' : 'append' };
    }
    case 'n8n-nodes-base.wait': {
      const unitSeconds: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86_400 };
      if (p['resume'] !== undefined && p['resume'] !== 'timeInterval') {
        context.warn(`“${context.nodeName}” waited for a webhook or form in n8n; it now waits a fixed time.`);
      }
      const seconds = n8nNumber(p['amount'], 1) * (unitSeconds[text(p['unit'], 'seconds')] ?? 1);
      if (seconds > 900) context.warn(`“${context.nodeName}” waited longer than 15 minutes; shortened to 15.`);
      return { ...base, type: 'wait', seconds: Math.min(900, Math.max(1, Math.round(seconds))) };
    }
    case 'n8n-nodes-base.stopAndError':
      return { ...base, type: 'stop_and_error', message: value(p['errorMessage']) || 'Stopped' };
    case 'n8n-nodes-base.noOp':
      return { ...base, type: 'no_op' };
    case 'n8n-nodes-base.sort': {
      const first = list(param(p, 'sortFieldsUi.sortField'))[0];
      return {
        ...base,
        type: 'sort',
        input: '',
        field: isObject(first) ? text(first['fieldName']) : '',
        order: isObject(first) && first['order'] === 'descending' ? 'desc' : 'asc',
      };
    }
    case 'n8n-nodes-base.limit':
      return {
        ...base,
        type: 'limit',
        input: '',
        maxItems: Math.max(1, Math.round(n8nNumber(p['maxItems'], 1))),
        keep: p['keep'] === 'lastItems' ? 'last' : 'first',
      };
    case 'n8n-nodes-base.removeDuplicates':
      return {
        ...base,
        type: 'remove_duplicates',
        input: '',
        field: p['compare'] === 'selectedFields' ? (text(p['fieldsToCompare']).split(',')[0] ?? '').trim() : '',
      };
    case 'n8n-nodes-base.splitOut':
      return { ...base, type: 'split_out', input: '', field: text(p['fieldToSplitOut']).split(',')[0]?.trim() ?? '' };
    case 'n8n-nodes-base.aggregate': {
      const first = list(param(p, 'fieldsToAggregate.fieldToAggregate'))[0];
      return {
        ...base,
        type: 'aggregate',
        input: '',
        field: isObject(first) ? text(first['fieldToAggregate']) : '',
        operation: 'collect',
      };
    }
    case 'n8n-nodes-base.summarize': {
      const first = list(param(p, 'fieldsToSummarize.values'))[0];
      const aggregation = isObject(first) ? text(first['aggregation'], 'count') : 'count';
      const operation = AGGREGATIONS.find(candidate => candidate === aggregation) ?? 'count';
      if (operation !== aggregation) context.warn(`“${context.nodeName}” used “${aggregation}”; it now counts.`);
      return { ...base, type: 'aggregate', input: '', field: isObject(first) ? text(first['field']) : '', operation };
    }
    case 'n8n-nodes-base.dateTime': {
      const operation = text(p['operation'], 'getCurrentDate');
      const unit = text(p['timeUnit'], 'days');
      const sign = operation === 'subtractFromDate' ? -1 : 1;
      const amount =
        operation === 'addToDate' || operation === 'subtractFromDate' ? sign * n8nNumber(p['duration'], 0) : 0;
      const magnitude = value(p['magnitude']);
      return {
        ...base,
        type: 'date_time',
        value: magnitude.includes('$now') ? '' : magnitude,
        addAmount: Math.round(amount),
        addUnit: DATE_UNITS.find(candidate => candidate === unit) ?? 'days',
        timezone: text(param(p, 'options.timezone'), 'UTC') || 'UTC',
      };
    }
    case 'n8n-nodes-base.crypto': {
      const action = text(p['action'], 'hash');
      const algorithm = text(p['type'], 'SHA256').toLowerCase();
      return {
        ...base,
        type: 'crypto',
        operation: action === 'hmac' ? 'hmac' : action === 'generate' ? 'uuid' : 'hash',
        algorithm: ALGORITHMS.find(candidate => candidate === algorithm) ?? 'sha256',
        encoding: p['encoding'] === 'base64' ? 'base64' : 'hex',
        value: value(p['value']),
        secret: value(p['secret']),
      };
    }
    case '@n8n/n8n-nodes-langchain.agent':
      context.warn(`“${context.nodeName}” is an AI agent: pick which Forgeflow agent runs it.`);
      return { ...base, type: 'agent', agentName: '', task: value(p['text']) || 'Handle this: {{ trigger.body }}' };
    default:
      return null;
  }
}

const N8N_TRIGGERS = new Set([
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.webhook',
]);

function isN8nTriggerType(type: string): boolean {
  return N8N_TRIGGERS.has(type) || /trigger$/i.test(type);
}

function importN8n(raw: JsonObject): WorkflowImport {
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const allNodes = list(raw['nodes'])
    .map(toN8nImportNode)
    .filter((node): node is N8nImportNode => node != null && node.type !== 'n8n-nodes-base.stickyNote');
  const triggerNodes = allNodes.filter(node => isN8nTriggerType(node.type));
  let stepNodes = allNodes.filter(node => !isN8nTriggerType(node.type));
  if (stepNodes.length > MAX_STEPS) {
    warn(`Only the first ${String(MAX_STEPS)} steps were imported (Forgeflow's limit per workflow).`);
    stepNodes = stepNodes.slice(0, MAX_STEPS);
  }

  const triggers: WorkflowTrigger[] = [];
  const addTrigger = (trigger: WorkflowTrigger) => {
    if (canAddTrigger({ triggers, type: trigger.type }) && triggers.length < 10) triggers.push(trigger);
  };
  for (const node of triggerNodes) {
    switch (node.type) {
      case 'n8n-nodes-base.manualTrigger':
        addTrigger({ type: 'manual' });
        break;
      case 'n8n-nodes-base.scheduleTrigger':
        for (const cron of n8nScheduleToCrons({ params: node.parameters, warn })) {
          addTrigger({ type: 'cron', cron, timezone: 'UTC' });
        }
        break;
      case 'n8n-nodes-base.cron':
        warn(`“${node.name}” uses n8n's old Cron node; it was replaced by “every day at 09:00”. Check it.`);
        addTrigger({ type: 'cron', cron: CRON_DEFAULT, timezone: 'UTC' });
        break;
      case 'n8n-nodes-base.webhook':
        addTrigger({ type: 'webhook' });
        break;
      default:
        warn(
          `“${node.name}” (${node.type}) is an app trigger Forgeflow does not have yet; a Webhook trigger stands in.`,
        );
        addTrigger({ type: 'webhook' });
    }
  }
  if (triggers.length === 0) triggers.push({ type: 'manual' });

  const nameToId = new Map<string, string | null>(triggerNodes.map(node => [node.name, null]));
  const taken = new Set<string>();
  for (const [index, node] of stepNodes.entries()) {
    const id = toStepId({ raw: node.name, index, taken });
    taken.add(id);
    nameToId.set(node.name, id);
  }

  // Edges first, so expressions can resolve `$json` to the one step feeding each node.
  const connections = isObject(raw['connections']) ? raw['connections'] : {};
  const typeByName = new Map(stepNodes.map(node => [node.name, node.type]));
  const switchRuleCounts = new Map(
    stepNodes
      .filter(node => node.type === 'n8n-nodes-base.switch')
      .map(node => [node.name, list(param(node.parameters, 'rules.values')).length]),
  );
  const edges: WorkflowEdge[] = [];
  const feeders = new Map<string, Set<string | null>>();
  for (const [sourceName, outputs] of Object.entries(connections)) {
    const sourceId = nameToId.get(sourceName);
    if (sourceId === undefined) continue;
    for (const [outputIndexValue, targetsList] of list(isObject(outputs) ? outputs['main'] : undefined).entries()) {
      for (const target of list(targetsList)) {
        if (!isObject(target)) continue;
        const targetId = nameToId.get(text(target['node']));
        if (targetId == null) continue;
        const fed = feeders.get(targetId) ?? new Set<string | null>();
        fed.add(sourceId);
        feeders.set(targetId, fed);
        if (sourceId === null) continue;
        const sourceType = typeByName.get(sourceName);
        let branch: string | undefined;
        if (sourceType === 'n8n-nodes-base.if') branch = outputIndexValue === 0 ? 'true' : 'false';
        if (sourceType === 'n8n-nodes-base.switch') {
          branch = outputIndexValue >= (switchRuleCounts.get(sourceName) ?? 0) ? 'fallback' : String(outputIndexValue);
        }
        const edge = { source: sourceId, target: targetId, ...(branch === undefined ? {} : { branch }) };
        if (!edges.some(existing => JSON.stringify(existing) === JSON.stringify(edge))) edges.push(edge);
      }
    }
  }

  const nodes: WorkflowNode[] = [];
  for (const node of stepNodes) {
    const id = nameToId.get(node.name);
    if (id == null) continue;
    const fed = [...(feeders.get(id) ?? new Set<string | null>())];
    const context: ExpressionContext = {
      nameToId,
      upstream: fed.length === 1 ? fed[0] : fed.length === 0 ? null : undefined,
      warn,
      nodeName: node.name,
    };
    const base: WorkflowNodeBase = {
      id,
      name: node.name.slice(0, 120),
      position: node.position,
      onError: node.continueOnError ? 'continue' : 'stop',
    };
    const converted = fromN8nNode({ node, base, context });
    if (converted == null) {
      warn(
        `“${node.name}” (${node.type}) has no Forgeflow equivalent yet; it was added as a No operation placeholder.`,
      );
      nodes.push({ ...base, type: 'no_op', name: `${node.name} (from n8n)`.slice(0, 120) });
    } else {
      nodes.push(converted);
    }
  }

  const listSteps = new Set<string>(['filter', 'sort', 'limit', 'remove_duplicates', 'split_out', 'aggregate']);
  if (nodes.some(node => listSteps.has(node.type))) {
    warn(
      'n8n passes lists of items between nodes, Forgeflow passes one value per step: check list steps after importing.',
    );
  }
  const placed = nodes.every(node => node.position.x !== 0 || node.position.y !== 0);
  return {
    format: 'n8n',
    warnings,
    draft: {
      name: toWorkflowName(text(raw['name'], 'imported-workflow')),
      manifest: {
        description: 'Imported from n8n.',
        status: 'active',
        triggers,
        nodes: placed ? nodes : layoutSteps({ nodes, edges }),
        edges,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Reads pasted or uploaded JSON in either format. Throws with a readable message otherwise. */
export function parseWorkflowImport(input: string): WorkflowImport {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch (error) {
    throw new Error('This is not valid JSON.', { cause: error });
  }
  // n8n's own "copy" wraps nothing, but some exports are arrays of one workflow.
  const workflow = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
  if (!isObject(workflow) || !Array.isArray(workflow['nodes'])) {
    throw new Error('No workflow found: expected a Forgeflow or n8n workflow with a "nodes" list.');
  }
  if (workflow['format'] === FORGEFLOW_FORMAT) return importForgeflow(workflow);
  if (isObject(workflow['connections'])) return importN8n(workflow);
  if (Array.isArray(workflow['edges']) || Array.isArray(workflow['triggers'])) return importForgeflow(workflow);
  throw new Error('Unrecognised workflow format: expected Forgeflow or n8n JSON.');
}

/**
 * Adds an imported workflow to the one being edited, like pasting into n8n: steps keep their
 * links, get fresh ids where needed, and land to the right of what is already there.
 */
export function mergeImportedWorkflow({
  manifest,
  imported,
}: {
  manifest: WorkflowManifest;
  imported: WorkflowManifest;
}): { manifest: WorkflowManifest; addedSteps: number; addedTriggers: number } {
  let incoming = imported;
  const taken = new Set(manifest.nodes.map(node => node.id));
  for (const [index, node] of imported.nodes.entries()) {
    if (!taken.has(node.id)) {
      taken.add(node.id);
      continue;
    }
    const fresh = toStepId({ raw: node.id, index, taken });
    taken.add(fresh);
    incoming = renameNodeId({ manifest: incoming, from: node.id, to: fresh });
  }
  const rightEdge = manifest.nodes.reduce((max, node) => Math.max(max, node.position.x), Number.NEGATIVE_INFINITY);
  const incomingLeft = incoming.nodes.reduce((min, node) => Math.min(min, node.position.x), Number.POSITIVE_INFINITY);
  const dx = manifest.nodes.length === 0 || incoming.nodes.length === 0 ? 0 : rightEdge + 320 - incomingLeft;
  const triggers = [...manifest.triggers];
  for (const trigger of incoming.triggers) {
    if (triggers.length < 10 && canAddTrigger({ triggers, type: trigger.type })) triggers.push(trigger);
  }
  return {
    addedSteps: incoming.nodes.length,
    addedTriggers: triggers.length - manifest.triggers.length,
    manifest: {
      ...manifest,
      triggers,
      nodes: [
        ...manifest.nodes,
        ...incoming.nodes.map(node => ({ ...node, position: { x: node.position.x + dx, y: node.position.y } })),
      ],
      edges: [...manifest.edges, ...incoming.edges],
    },
  };
}

export function workflowFileName({ name, format }: { name: string; format: WorkflowFileFormat }): string {
  return format === 'n8n' ? `${name}.n8n.json` : `${name}.forgeflow.json`;
}
