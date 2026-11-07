/**
 * Shared TrueForge SDK client for controller → server HTTP handoff (mTLS + API key).
 */
import { TrueForge } from '@truefoundry/trueforge-sdk';
import configuration from '../config';
import { createTlsFetch, normalizeTlsUrl } from '../http/tls';

function createClient(): TrueForge {
  const tls = {
    enabled: configuration.MTLS_ENABLED,
    dir: configuration.MTLS_CERTS_DIR,
  };
  const tlsFetch = createTlsFetch(tls);
  return new TrueForge({
    baseUrl: normalizeTlsUrl({ url: configuration.SERVER_URL, enabled: tls.enabled }),
    token: configuration.TRUEFORGE_API_KEY,
    timeoutInSeconds: 60,
    ...(tlsFetch === undefined ? {} : { fetch: tlsFetch }),
  });
}

const client = createClient();

/** Workflows are not in the generated SDK until CI regenerates it, so this one call is plain HTTP. */
async function postInternal({ path, body }: { path: string; body: unknown }): Promise<void> {
  const tls = { enabled: configuration.MTLS_ENABLED, dir: configuration.MTLS_CERTS_DIR };
  const baseUrl = normalizeTlsUrl({ url: configuration.SERVER_URL, enabled: tls.enabled });
  const response = await (createTlsFetch(tls) ?? fetch)(new URL(path, baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${configuration.TRUEFORGE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`POST ${path} returned ${String(response.status)}`);
  }
}

/** Controller loops share this client for all internal HTTP handoffs. */
export const internalTrueForgeClient = {
  async executeScheduleRun(scheduleRunId: string): Promise<void> {
    await client.internal.schedules.executeRun({ scheduleRunId });
  },

  async executeWorkflowCron(input: { workflowId: string; scheduledFor: Date }): Promise<void> {
    await postInternal({
      path: '/api/internal/workflows/runs/execute',
      body: { workflow_id: input.workflowId, scheduled_for: input.scheduledFor.toISOString() },
    });
  },

  async listPendingSandboxEnvironmentVersions(): Promise<string[]> {
    const response = await client.internal.sandboxEnvironments.listPending();
    return response.data.map(row => row.environmentVersionId);
  },

  async progressSandboxEnvironmentVersion(environmentVersionId: string): Promise<void> {
    await client.internal.sandboxEnvironments.progress({ environmentVersionId });
  },
};
