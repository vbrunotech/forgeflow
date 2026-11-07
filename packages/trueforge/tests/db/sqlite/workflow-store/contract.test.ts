import { SqliteWorkflowStore } from '../../../../src/db/sqlite/workflow-store/SqliteWorkflowStore';
import { runWorkflowStoreContractSuite } from '../../workflowStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteWorkflowStore (contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runWorkflowStoreContractSuite({ getStore: () => new SqliteWorkflowStore(env.db) });
});
