'use client';

import { useState } from 'react';

import type {
  WorkflowAggregateOperation,
  WorkflowConditionOperator,
  WorkflowCryptoNode,
  WorkflowDateTimeUnit,
  WorkflowHttpMethod,
  WorkflowNode,
} from '../../server/types.js';
import { AgentSearchPicker } from '../AgentSearchPicker.js';
import { auiInputClass } from '../lib/inputClasses.js';
import { Button } from '../primitives/Button.js';
import { PopoverSelect } from '../primitives/PopoverSelect.js';
import { NODE_TYPES } from './workflowDraft.js';

const SWITCH_MAX_RULES = 10;
const WAIT_MAX_SECONDS = 15 * 60;

const AGGREGATE_OPERATIONS: Array<{ value: WorkflowAggregateOperation; label: string }> = [
  { value: 'collect', label: 'Collect values into a list' },
  { value: 'count', label: 'Count' },
  { value: 'sum', label: 'Sum' },
  { value: 'average', label: 'Average' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' },
];

const DATE_UNITS: Array<{ value: WorkflowDateTimeUnit; label: string }> = [
  { value: 'seconds', label: 'seconds' },
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
  { value: 'weeks', label: 'weeks' },
];

const CRYPTO_OPERATIONS: Array<{ value: WorkflowCryptoNode['operation']; label: string }> = [
  { value: 'hash', label: 'Hash' },
  { value: 'hmac', label: 'HMAC signature' },
  { value: 'uuid', label: 'Generate UUID' },
];

const CRYPTO_ALGORITHMS: Array<{ value: WorkflowCryptoNode['algorithm']; label: string }> = [
  { value: 'sha256', label: 'SHA-256' },
  { value: 'sha512', label: 'SHA-512' },
  { value: 'sha1', label: 'SHA-1' },
  { value: 'md5', label: 'MD5' },
];

const CRYPTO_ENCODINGS: Array<{ value: WorkflowCryptoNode['encoding']; label: string }> = [
  { value: 'hex', label: 'Hex' },
  { value: 'base64', label: 'Base64' },
];

const LIST_INPUT_HINT = 'A template that resolves to a list. Leave empty to use the previous step.';
const ITEM_FIELD_HINT = 'Path inside each item, e.g. user.email. Leave empty to use the whole item.';

const METHODS: Array<{ value: WorkflowHttpMethod; label: string }> = [
  { value: 'GET', label: 'GET' },
  { value: 'POST', label: 'POST' },
  { value: 'PUT', label: 'PUT' },
  { value: 'PATCH', label: 'PATCH' },
  { value: 'DELETE', label: 'DELETE' },
];

const OPERATORS: Array<{ value: WorkflowConditionOperator; label: string }> = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'greater_than', label: 'is greater than' },
  { value: 'less_than', label: 'is less than' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];

const ON_ERROR: Array<{ value: WorkflowNode['onError']; label: string }> = [
  { value: 'stop', label: 'Stop the run' },
  { value: 'continue', label: 'Continue with next steps' },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-text-primary">{label}</span>
      {children}
      {hint != null ? <span className="mt-1 block text-xs text-text-secondary">{hint}</span> : null}
    </label>
  );
}

/** Key/value rows; used for HTTP headers and transform output fields. */
function KeyValueEditor({
  label,
  hint,
  values,
  onChange,
}: {
  label: string;
  hint?: string;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  const [newKey, setNewKey] = useState('');
  const entries = Object.entries(values);
  const add = () => {
    const key = newKey.trim();
    if (key === '' || Object.hasOwn(values, key)) return;
    onChange({ ...values, [key]: '' });
    setNewKey('');
  };
  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-text-primary">{label}</span>
      <div className="flex flex-col gap-1.5">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-center gap-1.5">
            <span className="w-24 shrink-0 truncate text-xs text-text-secondary" title={key}>
              {key}
            </span>
            <input
              aria-label={`${label}: ${key}`}
              value={value}
              onChange={event => onChange({ ...values, [key]: event.target.value })}
              className={auiInputClass('h-8 min-w-0 flex-1')}
            />
            <Button.Secondary
              type="button"
              size="small"
              aria-label={`Remove ${key}`}
              onClick={() => onChange(Object.fromEntries(entries.filter(([other]) => other !== key)))}
            >
              Remove
            </Button.Secondary>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <input
            aria-label={`New ${label} name`}
            placeholder="Name"
            value={newKey}
            onChange={event => setNewKey(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
            className={auiInputClass('h-8 min-w-0 flex-1')}
          />
          <Button.Secondary type="button" size="small" onClick={add}>
            Add
          </Button.Secondary>
        </div>
      </div>
      {hint != null ? <span className="mt-1 block text-xs text-text-secondary">{hint}</span> : null}
    </div>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-text-primary">{label}</span>
      <PopoverSelect aria-label={label} value={value} options={options} onValueChange={onChange} />
    </div>
  );
}

function TextField({
  label,
  hint,
  value,
  placeholder,
  mono = false,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
      <input
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
        className={auiInputClass(mono ? 'h-8 font-mono' : 'h-8')}
      />
    </Field>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={event => {
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
        }}
        className={auiInputClass('h-8')}
      />
    </Field>
  );
}

function needsRight(operator: WorkflowConditionOperator): boolean {
  return operator !== 'is_empty' && operator !== 'is_not_empty';
}

export function WorkflowNodeInspector({
  node,
  onChange,
  onRename,
  onRemoveSwitchRule,
  onDelete,
}: {
  node: WorkflowNode;
  onChange: (node: WorkflowNode) => void;
  /** Id changes also rewrite edges and templates, so they go through the parent. */
  onRename: (id: string) => void;
  /** Removing a rule also renumbers that switch's edges, so it goes through the parent. */
  onRemoveSwitchRule: (index: number) => void;
  onDelete: () => void;
}) {
  const [idDraft, setIdDraft] = useState(node.id);
  const idValid = /^[a-z][a-z0-9_]{0,63}$/.test(idDraft);

  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-xs font-medium tracking-wide text-text-secondary uppercase">{NODE_TYPES[node.type].label}</p>
      <Field label="Name">
        <input
          value={node.name}
          onChange={event => onChange({ ...node, name: event.target.value })}
          className={auiInputClass('h-8')}
        />
      </Field>
      <Field
        label="Step id"
        hint={
          idValid ? `Later steps read this one as {{ nodes.${idDraft}.output }}` : 'Lowercase letters, digits, and _.'
        }
      >
        <input
          value={idDraft}
          onChange={event => setIdDraft(event.target.value)}
          onBlur={() => {
            if (idValid && idDraft !== node.id) onRename(idDraft);
            else setIdDraft(node.id);
          }}
          className={auiInputClass('h-8 font-mono')}
        />
      </Field>

      {node.type === 'http_request' ? (
        <>
          <div className="flex items-end gap-2">
            <div className="shrink-0">
              <span className="mb-1.5 block text-sm font-medium text-text-primary">Method</span>
              <PopoverSelect
                aria-label="Method"
                value={node.method}
                options={METHODS}
                onValueChange={method => onChange({ ...node, method })}
              />
            </div>
            <div className="min-w-0 flex-1">
              <Field label="URL">
                <input
                  value={node.url}
                  placeholder="https://api.example.com/items"
                  onChange={event => onChange({ ...node, url: event.target.value })}
                  className={auiInputClass('h-8')}
                />
              </Field>
            </div>
          </div>
          <KeyValueEditor
            label="Headers"
            hint="Stored in plain text in the workflow. Avoid long-lived secrets."
            values={node.headers}
            onChange={headers => onChange({ ...node, headers })}
          />
          {node.method !== 'GET' ? (
            <Field label="Body">
              <textarea
                rows={4}
                value={node.body ?? ''}
                onChange={event => onChange({ ...node, body: event.target.value })}
                className={auiInputClass('resize-y py-2 font-mono')}
              />
            </Field>
          ) : null}
          <Field label="Timeout (seconds)">
            <input
              type="number"
              min={1}
              max={300}
              value={node.timeoutSeconds}
              onChange={event => {
                const timeoutSeconds = Number(event.target.value);
                if (timeoutSeconds >= 1 && timeoutSeconds <= 300) onChange({ ...node, timeoutSeconds });
              }}
              className={auiInputClass('h-8')}
            />
          </Field>
        </>
      ) : null}

      {node.type === 'transform' ? (
        <KeyValueEditor
          label="Output fields"
          hint="Each value can use templates, e.g. {{ trigger.body.email }}."
          values={node.values}
          onChange={values => onChange({ ...node, values })}
        />
      ) : null}

      {node.type === 'condition' ? (
        <>
          <Field label="Value">
            <input
              value={node.left}
              placeholder="{{ nodes.http_1.output.status }}"
              onChange={event => onChange({ ...node, left: event.target.value })}
              className={auiInputClass('h-8 font-mono')}
            />
          </Field>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-text-primary">Check</span>
            <PopoverSelect
              aria-label="Check"
              value={node.operator}
              options={OPERATORS}
              onValueChange={operator => onChange({ ...node, operator })}
            />
          </div>
          {node.operator !== 'is_empty' && node.operator !== 'is_not_empty' ? (
            <Field label="Compare with">
              <input
                value={node.right}
                onChange={event => onChange({ ...node, right: event.target.value })}
                className={auiInputClass('h-8 font-mono')}
              />
            </Field>
          ) : null}
          <p className="text-xs text-text-secondary">Connect the true and false handles to choose what runs next.</p>
        </>
      ) : null}

      {node.type === 'agent' ? (
        <>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-text-primary">Agent</span>
            <AgentSearchPicker
              aria-label="Agent"
              placeholder="Search agent"
              value={node.agentName}
              selectedLabel={node.agentName}
              onValueChange={() => undefined}
              onAgentPicked={agent => onChange({ ...node, agentName: agent.name })}
            />
          </div>
          <Field label="Task" hint="The agent runs unattended. If it needs approval or input, this step fails.">
            <textarea
              rows={5}
              value={node.task}
              placeholder="Summarise this: {{ nodes.http_1.output.body }}"
              onChange={event => onChange({ ...node, task: event.target.value })}
              className={auiInputClass('resize-y py-2')}
            />
          </Field>
        </>
      ) : null}

      {node.type === 'switch' ? (
        <>
          <TextField
            label="Value"
            mono
            value={node.value}
            placeholder="{{ trigger.body.status }}"
            onChange={value => onChange({ ...node, value })}
          />
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-text-primary">Rules</span>
            {node.rules.map((rule, index) => (
              <div key={index} className="flex flex-col gap-1.5 rounded-md border border-border p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-text-secondary">Output {index}</span>
                  {node.rules.length > 1 ? (
                    <Button.Secondary type="button" size="small" onClick={() => onRemoveSwitchRule(index)}>
                      Remove
                    </Button.Secondary>
                  ) : null}
                </div>
                <PopoverSelect
                  aria-label={`Rule ${String(index)} check`}
                  value={rule.operator}
                  options={OPERATORS}
                  onValueChange={operator =>
                    onChange({
                      ...node,
                      rules: node.rules.map((other, otherIndex) =>
                        otherIndex === index ? { ...other, operator } : other,
                      ),
                    })
                  }
                />
                {needsRight(rule.operator) ? (
                  <input
                    aria-label={`Rule ${String(index)} compare with`}
                    value={rule.right}
                    placeholder="Compare with"
                    onChange={event =>
                      onChange({
                        ...node,
                        rules: node.rules.map((other, otherIndex) =>
                          otherIndex === index ? { ...other, right: event.target.value } : other,
                        ),
                      })
                    }
                    className={auiInputClass('h-8 font-mono')}
                  />
                ) : null}
              </div>
            ))}
            {node.rules.length < SWITCH_MAX_RULES ? (
              <Button.Secondary
                type="button"
                size="small"
                onClick={() => onChange({ ...node, rules: [...node.rules, { operator: 'equals', right: '' }] })}
              >
                Add rule
              </Button.Secondary>
            ) : null}
            <p className="text-xs text-text-secondary">
              The first matching rule picks its output. If none match, the fallback output runs.
            </p>
          </div>
        </>
      ) : null}

      {node.type === 'merge' ? (
        <SelectField
          label="Mode"
          value={node.mode}
          options={[
            { value: 'append', label: 'Append: list every incoming output' },
            { value: 'combine', label: 'Combine: merge incoming objects' },
          ]}
          onChange={mode => onChange({ ...node, mode })}
        />
      ) : null}

      {node.type === 'wait' ? (
        <NumberField
          label="Seconds to wait"
          value={node.seconds}
          min={1}
          max={WAIT_MAX_SECONDS}
          onChange={seconds => onChange({ ...node, seconds })}
        />
      ) : null}

      {node.type === 'stop_and_error' ? (
        <Field label="Error message" hint="The run fails with this message. Supports templates.">
          <textarea
            rows={3}
            value={node.message}
            onChange={event => onChange({ ...node, message: event.target.value })}
            className={auiInputClass('resize-y py-2')}
          />
        </Field>
      ) : null}

      {node.type === 'no_op' ? (
        <p className="text-sm text-text-secondary">Passes the previous step's output through unchanged.</p>
      ) : null}

      {node.type === 'filter' ||
      node.type === 'sort' ||
      node.type === 'limit' ||
      node.type === 'remove_duplicates' ||
      node.type === 'split_out' ||
      node.type === 'aggregate' ? (
        <TextField
          label="List"
          hint={LIST_INPUT_HINT}
          mono
          value={node.input}
          placeholder="{{ nodes.http_1.output.body.items }}"
          onChange={input => onChange({ ...node, input })}
        />
      ) : null}

      {node.type === 'filter' ? (
        <>
          <TextField
            label="Field"
            hint={ITEM_FIELD_HINT}
            mono
            value={node.field}
            onChange={field => onChange({ ...node, field })}
          />
          <SelectField
            label="Keep items where the field"
            value={node.operator}
            options={OPERATORS}
            onChange={operator => onChange({ ...node, operator })}
          />
          {needsRight(node.operator) ? (
            <TextField label="Compare with" mono value={node.right} onChange={right => onChange({ ...node, right })} />
          ) : null}
        </>
      ) : null}

      {node.type === 'sort' ? (
        <>
          <TextField
            label="Sort by field"
            hint={ITEM_FIELD_HINT}
            mono
            value={node.field}
            onChange={field => onChange({ ...node, field })}
          />
          <SelectField
            label="Order"
            value={node.order}
            options={[
              { value: 'asc', label: 'Ascending' },
              { value: 'desc', label: 'Descending' },
            ]}
            onChange={order => onChange({ ...node, order })}
          />
        </>
      ) : null}

      {node.type === 'limit' ? (
        <>
          <NumberField
            label="Max items"
            value={node.maxItems}
            min={1}
            max={10_000}
            onChange={maxItems => onChange({ ...node, maxItems })}
          />
          <SelectField
            label="Keep"
            value={node.keep}
            options={[
              { value: 'first', label: 'First items' },
              { value: 'last', label: 'Last items' },
            ]}
            onChange={keep => onChange({ ...node, keep })}
          />
        </>
      ) : null}

      {node.type === 'remove_duplicates' ? (
        <TextField
          label="Compare by field"
          hint={ITEM_FIELD_HINT}
          mono
          value={node.field}
          onChange={field => onChange({ ...node, field })}
        />
      ) : null}

      {node.type === 'split_out' ? (
        <TextField
          label="List field to split out"
          hint="Each item's list in this field becomes separate entries."
          mono
          value={node.field}
          placeholder="tags"
          onChange={field => onChange({ ...node, field })}
        />
      ) : null}

      {node.type === 'aggregate' ? (
        <>
          <TextField
            label="Field"
            hint={ITEM_FIELD_HINT}
            mono
            value={node.field}
            onChange={field => onChange({ ...node, field })}
          />
          <SelectField
            label="Operation"
            value={node.operation}
            options={AGGREGATE_OPERATIONS}
            onChange={operation => onChange({ ...node, operation })}
          />
        </>
      ) : null}

      {node.type === 'date_time' ? (
        <>
          <TextField
            label="Date"
            hint="ISO date, Unix milliseconds, or a template. Leave empty for now."
            mono
            value={node.value}
            placeholder="{{ trigger.body.created_at }}"
            onChange={value => onChange({ ...node, value })}
          />
          <div className="flex items-end gap-2">
            <div className="w-24 shrink-0">
              <NumberField
                label="Add"
                value={node.addAmount}
                min={-1_000_000}
                max={1_000_000}
                onChange={addAmount => onChange({ ...node, addAmount })}
              />
            </div>
            <div className="min-w-0 flex-1">
              <SelectField
                label="Unit"
                value={node.addUnit}
                options={DATE_UNITS}
                onChange={addUnit => onChange({ ...node, addUnit })}
              />
            </div>
          </div>
          <TextField
            label="Time zone"
            value={node.timezone}
            placeholder="Europe/Paris"
            onChange={timezone => onChange({ ...node, timezone })}
          />
          <p className="text-xs text-text-secondary">
            Outputs iso, unix_ms, date, time, and weekday in that time zone.
          </p>
        </>
      ) : null}

      {node.type === 'crypto' ? (
        <>
          <SelectField
            label="Operation"
            value={node.operation}
            options={CRYPTO_OPERATIONS}
            onChange={operation => onChange({ ...node, operation })}
          />
          {node.operation !== 'uuid' ? (
            <>
              <TextField
                label="Value"
                mono
                value={node.value}
                placeholder="{{ trigger.body }}"
                onChange={value => onChange({ ...node, value })}
              />
              <SelectField
                label="Algorithm"
                value={node.algorithm}
                options={CRYPTO_ALGORITHMS}
                onChange={algorithm => onChange({ ...node, algorithm })}
              />
              <SelectField
                label="Encoding"
                value={node.encoding}
                options={CRYPTO_ENCODINGS}
                onChange={encoding => onChange({ ...node, encoding })}
              />
            </>
          ) : null}
          {node.operation === 'hmac' ? (
            <TextField
              label="Secret"
              hint="Stored in plain text in the workflow. Avoid long-lived secrets."
              mono
              value={node.secret}
              onChange={secret => onChange({ ...node, secret })}
            />
          ) : null}
        </>
      ) : null}

      <div>
        <span className="mb-1.5 block text-sm font-medium text-text-primary">If this step fails</span>
        <PopoverSelect
          aria-label="If this step fails"
          value={node.onError}
          options={ON_ERROR}
          onValueChange={onError => onChange({ ...node, onError })}
        />
      </div>

      <Button.Secondary type="button" size="large" onClick={onDelete}>
        Delete step
      </Button.Secondary>
    </div>
  );
}
