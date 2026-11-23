import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

const TEST_DATABASE_PREFIX = 'project_graduate_test_';
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PROJECT_ROOT = join(__dirname, '..', '..');
const PRISMA_CLI = join(PROJECT_ROOT, 'node_modules/prisma/build/index.js');

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  readonly runtimeUrl: string;
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

  const runtimeRole = `${name}_app`;
  const runtimePassword = randomBytes(24).toString('hex');
  let roleCreated = false;
  try {
    await migrate(databaseUrl(adminUrl, name));
    await withAdminClient(databaseUrl(adminUrl, name), async (client) => {
      await client.query(
        `CREATE ROLE ${quoteIdentifier(runtimeRole)} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
      roleCreated = true;
      await client.query(
        `GRANT graduate_runtime TO ${quoteIdentifier(runtimeRole)}`,
      );
    });
  } catch (error) {
    await dropTestDatabase(adminUrl, name).catch(() => undefined);
    if (roleCreated) {
      await withAdminClient(adminUrl, (client) =>
        client.query(`DROP ROLE ${quoteIdentifier(runtimeRole)}`),
      ).catch(() => undefined);
    }
    throw error;
  }

  let dropped = false;
  return {
    name,
    url: databaseUrl(adminUrl, name),
    runtimeUrl: runtimeDatabaseUrl(
      adminUrl,
      name,
      runtimeRole,
      runtimePassword,
    ),
    async drop(): Promise<void> {
      if (dropped) {
        return;
      }
      dropped = true;
      await dropTestDatabase(adminUrl, name);
      await withAdminClient(adminUrl, (client) =>
        client.query(`DROP ROLE ${quoteIdentifier(runtimeRole)}`),
      );
    },
  };
}

/**
 * Creates a disposable database with only the named earlier migrations applied
 * and marked resolved, so tests can insert pre-existing state before running
 * `runPrismaDeploy`.
 */
export async function withPremigrationDatabase(
  migrations: readonly string[],
  work: (databaseUrl: string) => Promise<void>,
): Promise<void> {
  const serverUrl = testServerUrl();
  const dbName = `${TEST_DATABASE_PREFIX}mig_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const adminUrl = databaseUrl(serverUrl, dbName);

  await withAdminClient(serverUrl, (client) =>
    client.query(`CREATE DATABASE ${quoteIdentifier(dbName)}`),
  );

  try {
    await withAdminClient(adminUrl, async (client) => {
      for (const migration of migrations) {
        const sql = await readFile(
          join(PROJECT_ROOT, 'prisma/migrations', migration, 'migration.sql'),
          'utf8',
        );
        await client.query(sql);
      }
    });

    for (const migration of migrations) {
      const resolved = await spawnMigrationCommand(
        process.execPath,
        [
          PRISMA_CLI,
          'migrate',
          'resolve',
          '--applied',
          migration,
          '--config',
          'prisma7.config.ts',
        ],
        adminUrl,
      );
      if (resolved.code !== 0) {
        throw new Error(
          `prisma migrate resolve failed for ${migration}: ${resolved.output}`,
        );
      }
    }

    await work(adminUrl);
  } finally {
    await dropTestDatabase(serverUrl, dbName).catch(() => undefined);
  }
}

export async function runPrismaDeploy(
  migrationDatabaseUrl: string,
): Promise<{ code: number | null; output: string }> {
  return spawnMigrationCommand(
    NPM_COMMAND,
    ['run', 'prisma:deploy', '--silent'],
    migrationDatabaseUrl,
  );
}

export async function withAdminClient<T>(
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

function runtimeDatabaseUrl(
  serverUrl: string,
  name: string,
  role: string,
  password: string,
): string {
  const url = new URL(databaseUrl(serverUrl, name));
  url.username = role;
  url.password = password;
  // Local operator connections may use peer-authenticated Unix sockets.
  // Restricted LOGINs must instead exercise actual password authentication.
  if (url.searchParams.get('host')?.startsWith('/')) {
    url.searchParams.delete('host');
    url.hostname = 'localhost';
  }
  return url.toString();
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
  const result = await runPrismaDeploy(databaseUrlValue);
  if (result.code !== 0) {
    throw new Error(
      `npm run prisma:deploy failed (exit ${result.code}).\n${result.output}`,
    );
  }
}

function spawnMigrationCommand(
  command: string,
  args: string[],
  migrationDatabaseUrl: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, MIGRATION_DATABASE_URL: migrationDatabaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && command === NPM_COMMAND,
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
    child.once('close', (code) => resolve({ code, output }));
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
