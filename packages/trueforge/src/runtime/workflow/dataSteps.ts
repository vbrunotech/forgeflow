import type { z } from '@hono/zod-openapi';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type {
  WorkflowAggregateNodeSchema,
  WorkflowConditionOperator,
  WorkflowCryptoNodeSchema,
  WorkflowDateTimeNodeSchema,
  WorkflowLimitNodeSchema,
  WorkflowSortNodeSchema,
} from '../../schemas/workflow';
import { WorkflowStepError } from './stepError';
import { lookupField, stringifyValue } from './template';

type AggregateOperation = z.infer<typeof WorkflowAggregateNodeSchema>['operation'];
type SortOrder = z.infer<typeof WorkflowSortNodeSchema>['order'];
type LimitKeep = z.infer<typeof WorkflowLimitNodeSchema>['keep'];
type DateTimeNode = z.infer<typeof WorkflowDateTimeNodeSchema>;
type CryptoNode = z.infer<typeof WorkflowCryptoNodeSchema>;

function isEmptyText(text: string): boolean {
  return text === '' || text === '[]' || text === '{}';
}

/** Shared by condition, switch, and filter so the same operator means the same thing everywhere. */
export function compareValues({
  left,
  operator,
  right,
}: {
  left: unknown;
  operator: WorkflowConditionOperator;
  right: string;
}): boolean {
  const leftText = stringifyValue(left);
  switch (operator) {
    case 'equals':
      return leftText === right;
    case 'not_equals':
      return leftText !== right;
    case 'contains':
      return leftText.includes(right);
    case 'greater_than':
      return Number(leftText) > Number(right);
    case 'less_than':
      return Number(leftText) < Number(right);
    case 'is_empty':
      return isEmptyText(leftText);
    case 'is_not_empty':
      return !isEmptyText(leftText);
  }
}

/** Data steps work on lists; a non-list input is a configuration mistake worth a clear error. */
export function requireList(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new WorkflowStepError(`Expected a list but got ${value === null ? 'nothing' : typeof value}`, {
      output: value,
    });
  }
  return value;
}

export function filterItems(params: {
  items: unknown[];
  field: string;
  operator: WorkflowConditionOperator;
  right: string;
}): unknown[] {
  const { items, field, operator, right } = params;
  return items.filter(item => compareValues({ left: lookupField({ value: item, path: field }), operator, right }));
}

/** Numbers sort numerically, everything else as text; missing values go last either way. */
export function sortItems({ items, field, order }: { items: unknown[]; field: string; order: SortOrder }): unknown[] {
  const direction = order === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const left = lookupField({ value: a, path: field });
    const right = lookupField({ value: b, path: field });
    if (left === null || right === null) {
      return left === right ? 0 : left === null ? 1 : -1;
    }
    if (typeof left === 'number' && typeof right === 'number') {
      return (left - right) * direction;
    }
    return stringifyValue(left).localeCompare(stringifyValue(right)) * direction;
  });
}

export function limitItems({ items, maxItems, keep }: { items: unknown[]; maxItems: number; keep: LimitKeep }) {
  return keep === 'first' ? items.slice(0, maxItems) : items.slice(-maxItems);
}

export function removeDuplicateItems({ items, field }: { items: unknown[]; field: string }): unknown[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = JSON.stringify(lookupField({ value: item, path: field }));
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Each item's list field becomes separate entries; items without that list are dropped. */
export function splitOutItems({ items, field }: { items: unknown[]; field: string }): unknown[] {
  return items.flatMap((item): unknown[] => {
    const value: unknown = lookupField({ value: item, path: field });
    return Array.isArray(value) ? Array.from<unknown>(value) : [];
  });
}

export function aggregateItems(params: { items: unknown[]; field: string; operation: AggregateOperation }): unknown {
  const { items, field, operation } = params;
  const values = items.map(item => lookupField({ value: item, path: field }));
  if (operation === 'collect') {
    return values;
  }
  if (operation === 'count') {
    return values.filter(value => value !== null).length;
  }
  const numbers = values.map(Number).filter(value => Number.isFinite(value));
  if (numbers.length === 0) {
    return null;
  }
  switch (operation) {
    case 'sum':
      return numbers.reduce((total, value) => total + value, 0);
    case 'average':
      return numbers.reduce((total, value) => total + value, 0) / numbers.length;
    case 'min':
      return Math.min(...numbers);
    case 'max':
      return Math.max(...numbers);
  }
}

const UNIT_MS: Record<DateTimeNode['add_unit'], number> = {
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
};

/** Parts read in the node's timezone, so `date` and `time` match what a person there sees. */
export function computeDateTime({
  node,
  value,
  now,
}: {
  node: Pick<DateTimeNode, 'add_amount' | 'add_unit' | 'timezone'>;
  value: string;
  now: Date;
}): Record<string, unknown> {
  const start = value.trim() === '' ? now : new Date(/^\d+$/.test(value.trim()) ? Number(value) : value);
  if (Number.isNaN(start.getTime())) {
    throw new WorkflowStepError(`Not a date: ${value}`);
  }
  const date = new Date(start.getTime() + node.add_amount * UNIT_MS[node.add_unit]);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: node.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === type)?.value ?? '';
  return {
    iso: date.toISOString(),
    unix_ms: date.getTime(),
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}:${part('second')}`,
    weekday: part('weekday'),
    timezone: node.timezone,
  };
}

export function computeCrypto({
  node,
  value,
  secret,
}: {
  node: Pick<CryptoNode, 'operation' | 'algorithm' | 'encoding'>;
  value: string;
  secret: string;
}): { value: string } {
  switch (node.operation) {
    case 'uuid':
      return { value: randomUUID() };
    case 'hash':
      return { value: createHash(node.algorithm).update(value).digest(node.encoding) };
    case 'hmac':
      if (secret === '') {
        throw new WorkflowStepError('HMAC needs a secret');
      }
      return { value: createHmac(node.algorithm, secret).update(value).digest(node.encoding) };
  }
}
