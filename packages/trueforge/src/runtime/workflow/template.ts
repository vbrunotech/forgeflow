/** `{{ trigger.body.name }}`-style references. Paths only: there is deliberately no expression evaluation. */
const TEMPLATE = /\{\{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;
const WHOLE_TEMPLATE = /^\{\{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}$/;

export interface WorkflowTemplateContext {
  trigger: Record<string, unknown>;
  nodes: Record<string, { output: unknown }>;
}

function isIndexable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Own properties only, so a template cannot reach `constructor` or `__proto__`. */
export function lookupField({ value, path }: { value: unknown; path: string }): unknown {
  if (path === '') {
    return value ?? null;
  }
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (!isIndexable(current) || !Object.hasOwn(current, segment)) {
      return null;
    }
    current = current[segment];
  }
  return current ?? null;
}

function lookupPath({ path, context }: { path: string; context: WorkflowTemplateContext }): unknown {
  return lookupField({ value: context, path });
}

export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Interpolates into a string. Missing paths render as empty. */
export function renderTemplate({ template, context }: { template: string; context: WorkflowTemplateContext }): string {
  return template.replace(TEMPLATE, (_match, path: string) => stringifyValue(lookupPath({ path, context })));
}

/** Like `renderTemplate`, but a value that is exactly one reference keeps its JSON type. */
export function resolveTemplateValue({
  template,
  context,
}: {
  template: string;
  context: WorkflowTemplateContext;
}): unknown {
  const whole = WHOLE_TEMPLATE.exec(template.trim());
  const path = whole?.[1];
  return path === undefined ? renderTemplate({ template, context }) : lookupPath({ path, context });
}
