import { sql, type Kysely } from 'kysely';

/** Workflows and their runs (canonical DDL owner). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`
    CREATE TABLE workflow (
      id text NOT NULL,
      tenant_id text NOT NULL,
      name text NOT NULL,
      manifest jsonb NOT NULL,
      status varchar(16) NOT NULL,
      webhook_token_hash text,
      next_run_at timestamptz,
      created_by_subject jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      CONSTRAINT workflow_pkey PRIMARY KEY (id)
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX workflow_name_uq ON workflow (tenant_id, name)`.execute(db);
  await sql`
    CREATE UNIQUE INDEX workflow_webhook_token_hash_uq
      ON workflow (webhook_token_hash)
      WHERE webhook_token_hash IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX workflow_next_run_at_idx
      ON workflow (next_run_at)
      WHERE next_run_at IS NOT NULL
  `.execute(db);

  await sql`
    CREATE TABLE workflow_run (
      id text NOT NULL,
      tenant_id text NOT NULL,
      workflow_id text NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
      status varchar(16) NOT NULL,
      trigger_type varchar(16) NOT NULL,
      input jsonb NOT NULL,
      manifest jsonb NOT NULL,
      steps jsonb NOT NULL,
      error text,
      created_by_subject jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      finished_at timestamptz,
      CONSTRAINT workflow_run_pkey PRIMARY KEY (id)
    )
  `.execute(db);
  await sql`CREATE INDEX workflow_run_list_idx ON workflow_run (workflow_id, created_at DESC)`.execute(db);
  await sql`
    CREATE INDEX workflow_run_running_idx
      ON workflow_run (created_at)
      WHERE status = 'running'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`DROP TABLE IF EXISTS workflow_run`.execute(db);
  await sql`DROP TABLE IF EXISTS workflow`.execute(db);
}
