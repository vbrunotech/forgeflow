import { createOutboundFetch, type OutboundFetch } from '@truefoundry/trueforge-core/core';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import type { WorkflowStepHandlers, WorkflowStepResult } from './engine';
import { WorkflowStepError } from './stepError';
import { renderTemplate } from './template';

const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Per-step `timeout_seconds` is enforced with an abort signal; these only bound the transport. */
const TRANSPORT_TIMEOUT_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 10_000;

// Not the shared `ssrfFetch`: its retries would replay a POST, and a workflow step is not known to be idempotent.
let workflowFetch: OutboundFetch | undefined;
function getWorkflowFetch(): OutboundFetch {
  workflowFetch ??= createOutboundFetch({
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    headersTimeoutMs: TRANSPORT_TIMEOUT_MS,
    bodyTimeoutMs: TRANSPORT_TIMEOUT_MS,
    maxRetries: 0,
    idempotent: false,
    userAgent: 'TrueForge-Workflow',
    metrics: { module: 'generic' },
  });
  return workflowFetch;
}

async function readCappedText(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) {
    return { text: '', truncated: false };
  }
  const reader: ReadableStreamDefaultReader<unknown> = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return { text: text + decoder.decode(), truncated: false };
    }
    if (!(value instanceof Uint8Array)) {
      throw new TypeError('Unexpected response body chunk');
    }
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { text, truncated: true };
    }
    text += decoder.decode(value, { stream: true });
  }
}

function parseBody(text: string, contentType: string | null): unknown {
  if (contentType?.includes('json') !== true) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const runHttpRequestStep: WorkflowStepHandlers['http_request'] = async ({
  node,
  context,
  signal,
}): Promise<WorkflowStepResult> => {
  const url = renderTemplate({ template: node.url, context });
  const headers = Object.fromEntries(
    Object.entries(node.headers).map(([name, template]) => [name, renderTemplate({ template, context })]),
  );
  const hasBody = node.body !== undefined && node.method !== 'GET';
  const response = await getWorkflowFetch().fetch(url, {
    method: node.method,
    headers,
    ...(hasBody ? { body: renderTemplate({ template: node.body ?? '', context }) } : {}),
    signal: AbortSignal.any([signal, AbortSignal.timeout(node.timeout_seconds * 1000)]),
  });
  const { text, truncated } = await readCappedText(response);
  // Request headers are left out of the output: they often carry credentials and outputs are stored.
  const output = {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') },
    // A truncated JSON document would not parse, so keep it as text.
    body: truncated ? text : parseBody(text, response.headers.get('content-type')),
    ...(truncated ? { truncated: true } : {}),
  };
  if (!response.ok) {
    throw new WorkflowStepError(`HTTP ${String(response.status)} from ${new URL(url).host}`, { output });
  }
  return { output };
};
