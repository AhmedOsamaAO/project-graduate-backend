import { createTestDatabase, type TestDatabase } from './test-database';
import { createTestStorage, type TestStorage } from './test-storage';

export interface TestEnvironment {
  readonly database: TestDatabase;
  readonly storage: TestStorage;
  close(): Promise<void>;
}

/**
 * Creates an isolated database and storage directory, switches the process to
 * the disposable database, and restores the previous configuration on close.
 */
export async function createTestEnvironment(): Promise<TestEnvironment> {
  const database = await createTestDatabase();
  const storage = await createTestStorage();
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;
  let closed = false;

  return {
    database,
    storage,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;

      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }

      try {
        await storage.remove();
      } finally {
        await database.drop();
      }
    },
  };
}
