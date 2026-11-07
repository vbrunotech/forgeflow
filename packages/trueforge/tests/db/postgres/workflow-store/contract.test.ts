import { sql } from 'kysely';

import { PostgresWorkflowStore } from '../../../../src/db/postgres/workflow-store/PostgresWorkflowStore';
import { runWorkflowStoreContractSuite } from '../../workflowStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresWorkflowStore (contract)', () => {
  let env: PostgresTestDatabase | undefined;

  beforeAll(async () => {
    env = await createPostgresTestDatabase();
    if (env === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
  });

  beforeEach(async () => {
    if (env !== undefined) {
      await sql`TRUNCATE TABLE workflow CASCADE`.execute(env.db);
    }
  });

  runWorkflowStoreContractSuite({
    getStore: () => {
      if (env === undefined) {
        throw new Error('Postgres test environment not initialized');
      }
      return new PostgresWorkflowStore(env.db);
    },
  });
});
