import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';

const TEST_DATABASE_PREFIX = 'project_graduate_test_';
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PROJECT_ROOT = join(__dirname, '..', '..');

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  drop(): Promise<void>;
}

/**
 * Creates a uniquely named database on the configured PostgreSQL server,
 * applies the committed migrations, and returns handles for cleanup.
 *
 * The database named in `TEST_DATABASE_URL` (or `DATABASE_URL`) is only used
 * as a server connection. It is never migrated, truncated, or dropped.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = testServerUrl();
  const name = `${TEST_DATABASE_PREFIX}${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

  await withAdminClient(adminUrl, (client) =>
    client.query(`CREATE DATABASE ${quoteIdentifier(name)}`),
  );

  try {
    await migrate(databaseUrl(adminUrl, name));
  } catch (error) {
    await dropTestDatabase(adminUrl, name).catch(() => undefined);
    throw error;
  }

  let dropped = false;
  return {
    name,
    url: databaseUrl(adminUrl, name),
    async drop(): Promise<void> {
      if (dropped) {
        return;
      }
      dropped = true;
      await dropTestDatabase(adminUrl, name);
    },
  };
}

function testServerUrl(): string {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The test database helper must not run in production');
  }

  const value = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      'TEST_DATABASE_URL or DATABASE_URL must be set for database-backed tests. See .env.test.example.',
    );
  }

  const parsed = new URL(value);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `Expected a PostgreSQL connection string, received ${parsed.protocol}`,
    );
  }

  return value;
}

function databaseUrl(serverUrl: string, name: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdminClient<T>(
  connectionString: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function dropTestDatabase(
  serverUrl: string,
  name: string,
): Promise<void> {
  assertTestDatabaseName(name);
  await withAdminClient(serverUrl, async (client) => {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
  });
}

async function migrate(databaseUrlValue: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(NPM_COMMAND, ['run', 'prisma:deploy', '--silent'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrlValue },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `npm run prisma:deploy failed (${signal ?? `exit ${code}`}).\n${output}`,
        ),
      );
    });
  });
}

function assertTestDatabaseName(name: string): void {
  if (!name.startsWith(TEST_DATABASE_PREFIX)) {
    throw new Error(`Refusing to drop non-test database "${name}"`);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
