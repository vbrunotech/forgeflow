import { sql, type Kysely } from 'kysely';

/** Workflows and their runs — mirrors db/postgres/migrations/20261105_000001_workflow.ts. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE workflow (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        manifest BLOB NOT NULL,
        status TEXT NOT NULL CHECK (length(status) <= 16),
        webhook_token_hash TEXT,
        next_run_at TEXT,
        created_by_subject BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);
    await sql`CREATE UNIQUE INDEX workflow_name_uq ON workflow (tenant_id, name)`.execute(trx);
    await sql`
      CREATE UNIQUE INDEX workflow_webhook_token_hash_uq
        ON workflow (webhook_token_hash)
        WHERE webhook_token_hash IS NOT NULL
    `.execute(trx);
    await sql`
      CREATE INDEX workflow_next_run_at_idx
        ON workflow (next_run_at)
        WHERE next_run_at IS NOT NULL
    `.execute(trx);

    await sql`
      CREATE TABLE workflow_run (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (length(status) <= 16),
        trigger_type TEXT NOT NULL CHECK (length(trigger_type) <= 16),
        input BLOB NOT NULL,
        manifest BLOB NOT NULL,
        steps BLOB NOT NULL,
        error TEXT,
        created_by_subject BLOB NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX workflow_run_list_idx ON workflow_run (workflow_id, created_at DESC)`.execute(trx);
    await sql`
      CREATE INDEX workflow_run_running_idx
        ON workflow_run (created_at)
        WHERE status = 'running'
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS workflow_run`.execute(trx);
    await sql`DROP TABLE IF EXISTS workflow`.execute(trx);
  });
}
