import { executeWorkflow, type WorkflowStepHandlers } from '../../../../src/runtime/workflow/engine';
import { InvalidWorkflowError, validateWorkflowGraph } from '../../../../src/runtime/workflow/graph';
import { WorkflowStepError } from '../../../../src/runtime/workflow/stepError';
import { WorkflowManifestSchema, type WorkflowManifest, type WorkflowRunStep } from '../../../../src/schemas/workflow';

const position = { x: 0, y: 0 };

function manifest(input: { nodes: unknown[]; edges?: unknown[] }): WorkflowManifest {
  return WorkflowManifestSchema.parse({ triggers: [{ type: 'manual' }], edges: [], ...input });
}

function transform(id: string, values: Record<string, string> = { id }, extra: object = {}) {
  return { id, name: id, position, type: 'transform', values, ...extra };
}

function http(id: string, extra: object = {}) {
  return { id, name: id, position, type: 'http_request', url: 'https://example.com', ...extra };
}

function condition(id: string, left: string, operator: string, right = '') {
  return { id, name: id, position, type: 'condition', left, operator, right };
}

function switchNode(id: string, value: string, rules: Array<{ operator: string; right?: string }>) {
  return { id, name: id, position, type: 'switch', value, rules };
}

function step(id: string, type: string, extra: object = {}) {
  return { id, name: id, position, type, ...extra };
}

function handlers(overrides: Partial<WorkflowStepHandlers> = {}): WorkflowStepHandlers {
  return {
    http_request: () => Promise.resolve({ output: { status: 200 } }),
    agent: () => Promise.resolve({ output: { text: 'done' } }),
    wait: ({ node }) => Promise.resolve({ output: { waited_seconds: node.seconds } }),
    ...overrides,
  };
}

async function run(input: {
  manifest: WorkflowManifest;
  trigger?: Record<string, unknown>;
  handlers?: WorkflowStepHandlers;
  signal?: AbortSignal;
}) {
  const snapshots: WorkflowRunStep[][] = [];
  const result = await executeWorkflow({
    manifest: input.manifest,
    trigger: input.trigger ?? {},
    handlers: input.handlers ?? handlers(),
    signal: input.signal ?? new AbortController().signal,
    onProgress: steps => {
      snapshots.push(steps);
      return Promise.resolve();
    },
  });
  const byId = Object.fromEntries(result.steps.map(step => [step.node_id, step]));
  return { result, byId, snapshots };
}

describe('validateWorkflowGraph', () => {
  it('orders nodes topologically regardless of declaration order', () => {
    const ordered = validateWorkflowGraph(
      manifest({
        nodes: [transform('c'), transform('a'), transform('b')],
        edges: [
          { source: 'a', target: 'b' },
          { source: 'b', target: 'c' },
        ],
      }),
    );
    expect(ordered.map(node => node.id)).toEqual(['a', 'b', 'c']);
  });

  it.each([
    [
      'a cycle',
      {
        nodes: [transform('a'), transform('b')],
        edges: [
          { source: 'a', target: 'b' },
          { source: 'b', target: 'a' },
        ],
      },
      /cycle/,
    ],
    ['a self loop', { nodes: [transform('a')], edges: [{ source: 'a', target: 'a' }] }, /cycle/],
    ['duplicate ids', { nodes: [transform('a'), transform('a')] }, /Duplicate node/],
    ['an unknown target', { nodes: [transform('a')], edges: [{ source: 'a', target: 'b' }] }, /unknown node/],
    [
      'a condition edge without a branch',
      { nodes: [condition('a', 'x', 'equals', 'x'), transform('b')], edges: [{ source: 'a', target: 'b' }] },
      /true, false/,
    ],
    [
      'a switch edge naming a rule that does not exist',
      {
        nodes: [switchNode('a', 'x', [{ operator: 'equals', right: 'x' }]), transform('b')],
        edges: [{ source: 'a', target: 'b', branch: '3' }],
      },
      /0, fallback/,
    ],
    [
      'a branch on a non-condition',
      { nodes: [transform('a'), transform('b')], edges: [{ source: 'a', target: 'b', branch: 'true' }] },
      /does not branch/,
    ],
  ])('rejects %s', (_label, input, message) => {
    expect(() => validateWorkflowGraph(manifest(input))).toThrow(InvalidWorkflowError);
    expect(() => validateWorkflowGraph(manifest(input))).toThrow(message);
  });
});

describe('executeWorkflow', () => {
  it('passes outputs between steps and exposes the trigger', async () => {
    const { result, byId } = await run({
      trigger: { body: { name: 'Ada', tags: ['x'] } },
      manifest: manifest({
        nodes: [
          transform('first', { greeting: 'Hello {{ trigger.body.name }}', tags: '{{ trigger.body.tags }}' }),
          transform('second', { copy: '{{ nodes.first.output.greeting }}!' }),
        ],
        edges: [{ source: 'first', target: 'second' }],
      }),
    });
    expect(result.status).toBe('succeeded');
    // A value that is exactly one reference keeps its JSON type.
    expect(byId['first']?.output).toEqual({ greeting: 'Hello Ada', tags: ['x'] });
    expect(byId['second']?.output).toEqual({ copy: 'Hello Ada!' });
  });

  it('runs only the taken branch and skips what depends on the other', async () => {
    const { result, byId } = await run({
      trigger: { body: { amount: 150 } },
      manifest: manifest({
        nodes: [
          condition('big', '{{ trigger.body.amount }}', 'greater_than', '100'),
          transform('yes'),
          transform('no'),
          transform('after_no'),
        ],
        edges: [
          { source: 'big', target: 'yes', branch: 'true' },
          { source: 'big', target: 'no', branch: 'false' },
          { source: 'no', target: 'after_no' },
        ],
      }),
    });
    expect(result.status).toBe('succeeded');
    expect(byId['big']?.output).toEqual({ result: true });
    expect(byId['yes']?.status).toBe('succeeded');
    expect(byId['no']?.status).toBe('skipped');
    expect(byId['after_no']?.status).toBe('skipped');
  });

  it('runs a join once when either branch reaches it', async () => {
    const http_request = jest.fn(() => Promise.resolve({ output: {} }));
    const { byId } = await run({
      handlers: handlers({ http_request }),
      manifest: manifest({
        nodes: [condition('check', 'a', 'equals', 'a'), transform('left'), transform('right'), http('join')],
        edges: [
          { source: 'check', target: 'left', branch: 'true' },
          { source: 'check', target: 'right', branch: 'false' },
          { source: 'left', target: 'join' },
          { source: 'right', target: 'join' },
        ],
      }),
    });
    expect(http_request).toHaveBeenCalledTimes(1);
    expect(byId['join']?.status).toBe('succeeded');
  });

  it('stops on error by default and keeps the failed output', async () => {
    const { result, byId } = await run({
      handlers: handlers({
        http_request: () => Promise.reject(new WorkflowStepError('HTTP 500', { output: { status: 500 } })),
      }),
      manifest: manifest({
        nodes: [http('call'), transform('after'), transform('unrelated')],
        edges: [{ source: 'call', target: 'after' }],
      }),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Step call failed: HTTP 500');
    expect(byId['call']).toMatchObject({ status: 'failed', error: 'HTTP 500', output: { status: 500 } });
    expect(byId['after']?.status).toBe('skipped');
    expect(byId['unrelated']?.status).toBe('skipped');
  });

  it('continues past a failed step when on_error is continue', async () => {
    const { result, byId } = await run({
      handlers: handlers({ http_request: () => Promise.reject(new Error('boom')) }),
      manifest: manifest({
        nodes: [
          http('call', { on_error: 'continue' }),
          transform('after', { failed: 'x{{ nodes.call.output.body }}' }),
        ],
        edges: [{ source: 'call', target: 'after' }],
      }),
    });
    expect(result.status).toBe('succeeded');
    expect(byId['call']?.status).toBe('failed');
    expect(byId['after']?.output).toEqual({ failed: 'x' });
  });

  it('fails instead of starting another step once the time limit passes', async () => {
    const { result, byId } = await run({
      signal: AbortSignal.abort(),
      manifest: manifest({ nodes: [transform('never')] }),
    });
    expect(result).toMatchObject({ status: 'failed', error: 'Workflow run exceeded its time limit' });
    expect(byId['never']?.status).toBe('skipped');
  });

  it('truncates oversized outputs', async () => {
    const { byId } = await run({
      handlers: handlers({ http_request: () => Promise.resolve({ output: { body: 'x'.repeat(300 * 1024) } }) }),
      manifest: manifest({ nodes: [http('big')] }),
    });
    expect(byId['big']?.output).toMatchObject({ truncated: true });
  });

  it('reports progress and links the agent session while the agent runs', async () => {
    const { snapshots, byId } = await run({
      handlers: handlers({
        agent: async ({ onSession }) => {
          await onSession('session-1');
          return { output: { text: 'ok' } };
        },
      }),
      manifest: manifest({
        nodes: [{ id: 'think', name: 'Think', position, type: 'agent', agent_name: 'reporter', task: 'Go' }],
      }),
    });
    expect(snapshots[0]?.[0]?.status).toBe('running');
    expect(snapshots[1]?.[0]).toMatchObject({ status: 'running', session_id: 'session-1' });
    expect(byId['think']).toMatchObject({ status: 'succeeded', session_id: 'session-1' });
  });

  it('does not let templates reach object prototypes', async () => {
    const { byId } = await run({
      manifest: manifest({
        nodes: [transform('safe', { a: '{{ trigger.constructor.name }}', b: 'x{{ trigger.__proto__ }}' })],
      }),
    });
    expect(byId['safe']?.output).toEqual({ a: null, b: 'x' });
  });

  it('routes a switch to the first matching rule, or to fallback', async () => {
    const build = (status: string) =>
      run({
        trigger: { body: { status } },
        manifest: manifest({
          nodes: [
            switchNode('route', '{{ trigger.body.status }}', [
              { operator: 'equals', right: 'new' },
              { operator: 'contains', right: 'close' },
            ]),
            transform('on_new'),
            transform('on_closed'),
            transform('other'),
          ],
          edges: [
            { source: 'route', target: 'on_new', branch: '0' },
            { source: 'route', target: 'on_closed', branch: '1' },
            { source: 'route', target: 'other', branch: 'fallback' },
          ],
        }),
      });
    const closed = await build('closed');
    expect(closed.byId['route']?.output).toEqual({ matched: 1, value: 'closed' });
    expect(closed.byId['on_closed']?.status).toBe('succeeded');
    expect(closed.byId['on_new']?.status).toBe('skipped');
    const unknown = await build('weird');
    expect(unknown.byId['other']?.status).toBe('succeeded');
    expect(unknown.byId['on_closed']?.status).toBe('skipped');
  });

  it('merges outputs of the branches that ran', async () => {
    const nodes = (mode: string) => [
      transform('a', { x: '1' }),
      transform('b', { y: '2' }),
      step('join', 'merge', { mode }),
    ];
    const edges = [
      { source: 'a', target: 'join' },
      { source: 'b', target: 'join' },
    ];
    const appended = await run({ manifest: manifest({ nodes: nodes('append'), edges }) });
    expect(appended.byId['join']?.output).toEqual([{ x: '1' }, { y: '2' }]);
    const combined = await run({ manifest: manifest({ nodes: nodes('combine'), edges }) });
    expect(combined.byId['join']?.output).toEqual({ x: '1', y: '2' });
  });

  it('chains data steps on the previous output when no input is set', async () => {
    const { result, byId } = await run({
      trigger: {
        body: {
          users: [
            { name: 'b', age: 40, team: 'x' },
            { name: 'a', age: 20, team: 'y' },
            { name: 'c', age: 30, team: 'x' },
            { name: 'c', age: 30, team: 'x' },
          ],
        },
      },
      manifest: manifest({
        nodes: [
          step('dedupe', 'remove_duplicates', { input: '{{ trigger.body.users }}' }),
          step('adults', 'filter', { field: 'age', operator: 'greater_than', right: '25' }),
          step('sorted', 'sort', { field: 'name', order: 'desc' }),
          step('top', 'limit', { max_items: 1 }),
          step('total', 'aggregate', { input: '{{ nodes.adults.output }}', field: 'age', operation: 'sum' }),
        ],
        edges: [
          { source: 'dedupe', target: 'adults' },
          { source: 'adults', target: 'sorted' },
          { source: 'sorted', target: 'top' },
          { source: 'top', target: 'total' },
        ],
      }),
    });
    expect(result.status).toBe('succeeded');
    expect(byId['dedupe']?.output).toHaveLength(3);
    expect(byId['top']?.output).toEqual([{ name: 'c', age: 30, team: 'x' }]);
    expect(byId['total']?.output).toBe(70);
  });

  it('fails a data step clearly when its input is not a list', async () => {
    const { result, byId } = await run({
      manifest: manifest({ nodes: [step('bad', 'sort', { input: '{{ trigger.body }}' })] }),
      trigger: { body: { not: 'a list' } },
    });
    expect(result.status).toBe('failed');
    expect(byId['bad']?.error).toMatch(/Expected a list/);
  });

  it('stops the run with the rendered message', async () => {
    const { result, byId } = await run({
      trigger: { body: { id: 7 } },
      manifest: manifest({
        nodes: [step('halt', 'stop_and_error', { message: 'Order {{ trigger.body.id }} is invalid' }), transform('x')],
        edges: [{ source: 'halt', target: 'x' }],
      }),
    });
    expect(result.error).toBe('Step halt failed: Order 7 is invalid');
    expect(byId['x']?.status).toBe('skipped');
  });

  it('passes the previous output through a no-op and the wait handler', async () => {
    const wait = jest.fn(({ node }: { node: { seconds: number } }) =>
      Promise.resolve({ output: { waited_seconds: node.seconds } }),
    );
    const { byId } = await run({
      handlers: handlers({ wait }),
      manifest: manifest({
        nodes: [transform('a', { v: '1' }), step('pass', 'no_op'), step('pause', 'wait', { seconds: 5 })],
        edges: [
          { source: 'a', target: 'pass' },
          { source: 'pass', target: 'pause' },
        ],
      }),
    });
    expect(byId['pass']?.output).toEqual({ v: '1' });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(byId['pause']?.output).toEqual({ waited_seconds: 5 });
  });

  it('computes dates in the configured timezone and hashes text', async () => {
    const { byId } = await run({
      manifest: manifest({
        nodes: [
          step('when', 'date_time', {
            value: '2026-01-31T23:30:00Z',
            add_amount: 1,
            add_unit: 'hours',
            timezone: 'Europe/Paris',
          }),
          step('digest', 'crypto', { operation: 'hash', algorithm: 'sha256', value: 'abc' }),
        ],
      }),
    });
    expect(byId['when']?.output).toMatchObject({
      iso: '2026-02-01T00:30:00.000Z',
      date: '2026-02-01',
      time: '01:30:00',
      weekday: 'Sunday',
    });
    expect(byId['digest']?.output).toEqual({
      value: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
  });
});
