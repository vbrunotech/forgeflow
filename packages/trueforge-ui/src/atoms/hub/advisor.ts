import type { WorkflowDraft } from '../workflows/workflowDraft.js';
import { isObject, sanitizeWorkflowJson, text, type JsonObject } from '../workflows/workflowSanitize.js';

/** Fence the advisor wraps its proposal in, so the page can turn it into a draft. */
export const PROPOSAL_FENCE = 'forgeflow';

const STEP_TYPE_GUIDE = `- http_request: method (GET|POST|PUT|PATCH|DELETE), url, headers (object), body (string), timeoutSeconds
- transform: values (object of output field -> template)
- agent: agentName (leave ""), task
- condition: left, operator, right; outgoing edges need branch "true" or "false"
- switch: value, rules ([{operator, right}]); outgoing edges need branch "0", "1", ... or "fallback"
- merge: mode (append|combine)
- wait: seconds (1-900)
- stop_and_error: message
- no_op
- filter: input, field, operator, right
- sort: input, field, order (asc|desc)
- limit: input, maxItems, keep (first|last)
- remove_duplicates: input, field
- split_out: input, field
- aggregate: input, field, operation (collect|count|sum|average|min|max)
- date_time: value, addAmount, addUnit (seconds|minutes|hours|days|weeks), timezone
- crypto: operation (hash|hmac|uuid), algorithm (md5|sha1|sha256|sha512), encoding (hex|base64), value, secret
Operators: equals, not_equals, contains, greater_than, less_than, is_empty, is_not_empty.
Templates read earlier values: {{ trigger.body.x }}, {{ nodes.<step id>.output.x }}. For list steps, an empty "input" uses the previous step's output.`;

export const ADVISOR_INSTRUCTIONS = `You are the Forgeflow advisor. People come to you when they are not sure whether to build an agent or a workflow, and you draft it for them.

- A workflow runs steps the person defines in advance: same path every run, cheap, auditable. Best when the steps can be written down and inputs are predictable (syncing data, routing webhooks, scheduled checks).
- An agent lets a model decide the steps: handles messy, open-ended input, but cost and timing vary. Best for research, triage of free text, investigations.
- A workflow can include one agent step for just the part that needs judgment. Prefer that over a pure agent when most of the process is predictable.

How to work:
1. Understand what they want to automate. Ask at most two short clarifying questions, only when the answer changes your recommendation.
2. Recommend workflow or agent in two or three sentences, saying why.
3. Then add exactly one fenced block tagged ${PROPOSAL_FENCE} containing JSON, and nothing after it.

For a workflow:
\`\`\`${PROPOSAL_FENCE}
{"kind":"workflow","name":"kebab-case-name","description":"one sentence","triggers":[{"type":"manual"}],"steps":[{"id":"fetch","type":"http_request","name":"Fetch orders","method":"GET","url":"https://example.com/orders"}],"edges":[{"source":"fetch","target":"next_step"}]}
\`\`\`
"triggers" lists what starts the workflow: {"type":"manual"}, {"type":"webhook"}, and any number of {"type":"cron","cron":"0 9 * * 1","timezone":"UTC"}. Use at most one manual and one webhook. Step ids are lowercase letters, digits, and _. Use placeholder URLs like https://example.com when you do not know the real one. Available step types and their fields:
${STEP_TYPE_GUIDE}

For an agent:
\`\`\`${PROPOSAL_FENCE}
{"kind":"agent","name":"kebab-case-name","description":"one sentence","instructions":"the agent's system instructions, written in second person"}
\`\`\`

Keep replies short and friendly. Write in the language the person uses.`;

export type WorkflowProposal = {
  kind: 'workflow';
  name: string;
  description: string;
  draft: WorkflowDraft;
  /** Steps the advisor proposed that could not be used, so the person knows to add them by hand. */
  skippedSteps: string[];
};

export type AgentProposal = { kind: 'agent'; name: string; description: string; instructions: string };

export type AdvisorProposal = WorkflowProposal | AgentProposal;

function toWorkflowProposal(raw: JsonObject): WorkflowProposal {
  const { draft, skippedSteps } = sanitizeWorkflowJson({ raw, keepLayout: false });
  return { kind: 'workflow', name: draft.name, description: draft.manifest.description, skippedSteps, draft };
}

function toProposal(raw: unknown): AdvisorProposal | null {
  if (!isObject(raw)) return null;
  if (raw['kind'] === 'workflow') return toWorkflowProposal(raw);
  if (raw['kind'] === 'agent' && typeof raw['instructions'] === 'string' && raw['instructions'].trim() !== '') {
    return {
      kind: 'agent',
      name: text(raw['name'], 'new-agent'),
      description: text(raw['description']),
      instructions: raw['instructions'].trim(),
    };
  }
  return null;
}

const FENCE = new RegExp('```' + PROPOSAL_FENCE + '\\s*\\n([\\s\\S]*?)```', 'i');
/** While streaming, hide a proposal block that has not closed yet. */
const OPEN_FENCE = new RegExp('```' + PROPOSAL_FENCE + '[\\s\\S]*$', 'i');

/** Splits an advisor reply into the prose to show and the proposal, if it made one. */
export function parseAdvisorReply(reply: string): { text: string; proposal: AdvisorProposal | null } {
  const match = FENCE.exec(reply);
  if (match == null) return { text: reply.replace(OPEN_FENCE, '').trim(), proposal: null };
  let proposal: AdvisorProposal | null = null;
  try {
    proposal = toProposal(JSON.parse(match[1] ?? ''));
  } catch {
    proposal = null;
  }
  return { text: reply.replace(FENCE, '').trim(), proposal };
}
