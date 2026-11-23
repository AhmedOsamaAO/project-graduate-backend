import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import { ChangeHistoryService } from '../../src/change-history/change-history.service';
import { ERROR_CODES } from '../../src/common/errors/error-codes';
import { PrismaClient } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  FIXED_OFFICE,
  assertFixedOfficeHierarchy,
} from '../../src/reference-data/fixed-office';
import { ReferenceDataService } from '../../src/reference-data/reference-data.service';
import { StaffAccounts } from '../../src/staff-access/staff-accounts';
import {
  createTestDatabase,
  type TestDatabase,
} from '../support/test-database';

const PROJECT_ROOT = join(__dirname, '..', '..');
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PRISMA_CLI = join(PROJECT_ROOT, 'node_modules/prisma/build/index.js');

const PRE_PROVISIONING_MIGRATIONS = [
  '20261031120000_baseline',
  '20261115090000_staff_accounts_history',
  '20261120120000_staff_auth_sessions_history',
  '20261123120000_reference_catalog_schema',
] as const;

describe('reference catalog and fixed office provisioning (db)', () => {
  let database: TestDatabase;
  let prisma: PrismaClient;
  let service: ReferenceDataService;
  let staffUserId: number;

  beforeAll(async () => {
    database = await createTestDatabase();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: database.runtimeUrl }),
    });
    const historyService = new ChangeHistoryService(
      prisma as unknown as PrismaService,
    );
    service = new ReferenceDataService(
      prisma as unknown as PrismaService,
      historyService,
    );
    const accounts = new StaffAccounts(prisma);
    const staff = await accounts.provision(
      { attribution: 'reference-catalog db test' },
      {
        username: 'catalog.db.staff',
        fullName: 'Catalog DB Staff',
        password: 'catalog db valid password',
      },
    );
    staffUserId = staff.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.drop();
  });

  it('provisions the fixed office hierarchy with advanced sequences on initial migration', async () => {
    await expect(assertFixedOfficeHierarchy(prisma)).resolves.toBeUndefined();

    const fixedInstitution = await prisma.educationalInstitution.findUnique({
      where: { id: FIXED_OFFICE.institution.id },
    });
    expect(fixedInstitution).toMatchObject({
      id: 1,
      name: 'Zagazig University',
      institutionType: 'PUBLIC_UNIVERSITY',
      version: 1,
    });

    const fixedFaculty = await prisma.faculty.findUnique({
      where: { id: FIXED_OFFICE.faculty.id },
    });
    expect(fixedFaculty).toMatchObject({
      id: 1,
      institutionId: 1,
      name: 'Faculty of Computer and Information',
      version: 1,
    });

    const createdInstitution = await service.createInstitution(
      { staffUserId },
      { name: 'Ain Shams University', institutionType: 'PUBLIC_UNIVERSITY' },
    );
    expect(createdInstitution.id).toBeGreaterThanOrEqual(2);
    expect(createdInstitution.isFixedOffice).toBe(false);

    const createdFaculty = await service.createFaculty(
      { staffUserId },
      { institutionId: createdInstitution.id, name: 'Faculty of Science' },
    );
    expect(createdFaculty.id).toBeGreaterThanOrEqual(2);
    expect(createdFaculty.isFixedOffice).toBe(false);
  });

  it('rejects fixed-office migration when reserved id = 1 has a conflicting institution without overwriting it', async () => {
    await withPremigrationDatabase(async (dbUrl) => {
      const admin = new Client({ connectionString: dbUrl });
      await admin.connect();
      try {
        await admin.query(
          `INSERT INTO educational_institution (id, name, institution_type, version, created_at, updated_at)
           VALUES (1, 'Conflicting University', 'PRIVATE_UNIVERSITY', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        );

        const deployResult = await runPrismaDeploy(dbUrl);
        expect(deployResult.code).not.toBe(0);

        const { rows } = await admin.query<{
          id: number;
          name: string;
          institution_type: string;
          version: number;
        }>(
          'SELECT id, name, institution_type, version FROM educational_institution WHERE id = 1',
        );
        expect(rows).toEqual([
          {
            id: 1,
            name: 'Conflicting University',
            institution_type: 'PRIVATE_UNIVERSITY',
            version: 4,
          },
        ]);
      } finally {
        await admin.end();
      }
    });
  });

  it('rejects fixed-office migration when reserved faculty id = 1 or fixed name at non-reserved id conflicts without overwriting', async () => {
    await withPremigrationDatabase(async (dbUrl) => {
      const admin = new Client({ connectionString: dbUrl });
      await admin.connect();
      try {
        await admin.query(
          `INSERT INTO educational_institution (id, name, institution_type, version, created_at, updated_at)
           VALUES (1, 'Zagazig University', 'PUBLIC_UNIVERSITY', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        );
        await admin.query(
          `INSERT INTO faculty (id, institution_id, name, version, created_at, updated_at)
           VALUES (1, 1, 'Faculty of Engineering', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        );

        const deployResult = await runPrismaDeploy(dbUrl);
        expect(deployResult.code).not.toBe(0);

        const { rows } = await admin.query<{
          id: number;
          name: string;
          version: number;
        }>('SELECT id, name, version FROM faculty WHERE id = 1');
        expect(rows).toEqual([
          { id: 1, name: 'Faculty of Engineering', version: 2 },
        ]);
      } finally {
        await admin.end();
      }
    });

    await withPremigrationDatabase(async (dbUrl) => {
      const admin = new Client({ connectionString: dbUrl });
      await admin.connect();
      try {
        await admin.query(
          `INSERT INTO educational_institution (id, name, institution_type, version, created_at, updated_at)
           VALUES (1, 'Zagazig University', 'PUBLIC_UNIVERSITY', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        );
        await admin.query(
          `INSERT INTO faculty (id, institution_id, name, version, created_at, updated_at)
           VALUES (5, 1, 'Faculty of Computer and Information', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        );

        const deployResult = await runPrismaDeploy(dbUrl);
        expect(deployResult.code).not.toBe(0);

        const { rows } = await admin.query<{
          id: number;
          name: string;
          version: number;
        }>('SELECT id, name, version FROM faculty ORDER BY id');
        expect(rows).toEqual([
          { id: 5, name: 'Faculty of Computer and Information', version: 3 },
        ]);
      } finally {
        await admin.end();
      }
    });
  });

  it('succeeds idempotently on matching fixed rows and advances sequences without rewinding higher sequences', async () => {
    await withPremigrationDatabase(async (dbUrl) => {
      const admin = new Client({ connectionString: dbUrl });
      await admin.connect();
      try {
        await admin.query(
          `INSERT INTO educational_institution (id, name, institution_type, version, created_at, updated_at)
           VALUES
             (1, 'Zagazig University', 'PUBLIC_UNIVERSITY', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
             (10, 'Other University', 'PRIVATE_UNIVERSITY', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        );
        await admin.query(
          `SELECT setval('educational_institution_id_seq', 15, true)`,
        );
        await admin.query(
          `INSERT INTO faculty (id, institution_id, name, version, created_at, updated_at)
           VALUES
             (1, 1, 'Faculty of Computer and Information', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
             (8, 10, 'Faculty of Commerce', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        );
        await admin.query(`SELECT setval('faculty_id_seq', 3, true)`);

        const deployResult = await runPrismaDeploy(dbUrl);
        expect(deployResult.code).toBe(0);

        const nextInst = await admin.query<{ nextval: string }>(
          `SELECT nextval('educational_institution_id_seq')::text AS nextval`,
        );
        expect(Number(nextInst.rows[0].nextval)).toBe(16);

        const nextFac = await admin.query<{ nextval: string }>(
          `SELECT nextval('faculty_id_seq')::text AS nextval`,
        );
        expect(Number(nextFac.rows[0].nextval)).toBe(9);
      } finally {
        await admin.end();
      }
    });
  });

  it('enforces uniqueness, non-empty checks, restrictive foreign keys, and runtime privileges', async () => {
    const client = new Client({ connectionString: database.runtimeUrl });
    await client.connect();
    try {
      await expect(
        client.query('TRUNCATE educational_institution'),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await expect(client.query('TRUNCATE faculty')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(client.query('TRUNCATE department')).rejects.toMatchObject({
        code: '42501',
      });

      const inst = await service.createInstitution(
        { staffUserId },
        {
          name: 'Constraint Test Univ',
          institutionType: 'NATIONAL_UNIVERSITY',
        },
      );
      const fac = await service.createFaculty(
        { staffUserId },
        { institutionId: inst.id, name: 'Unique Faculty' },
      );
      const dept = await service.createDepartment(
        { staffUserId },
        { facultyId: fac.id, name: 'Unique Department' },
      );

      await client.query('BEGIN');

      await client.query('SAVEPOINT dup_faculty');
      await expect(
        client.query(
          `INSERT INTO faculty (institution_id, name, updated_at)
           VALUES ($1, 'Unique Faculty', CURRENT_TIMESTAMP)`,
          [inst.id],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await client.query('ROLLBACK TO SAVEPOINT dup_faculty');

      await client.query('SAVEPOINT dup_department');
      await expect(
        client.query(
          `INSERT INTO department (faculty_id, name, updated_at)
           VALUES ($1, 'Unique Department', CURRENT_TIMESTAMP)`,
          [fac.id],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await client.query('ROLLBACK TO SAVEPOINT dup_department');

      await client.query('SAVEPOINT blank_inst');
      await expect(
        client.query(
          `INSERT INTO educational_institution (name, institution_type, updated_at)
           VALUES ('   ', 'OTHER', CURRENT_TIMESTAMP)`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT blank_inst');

      await client.query('SAVEPOINT delete_restrict_inst');
      await expect(
        client.query('DELETE FROM educational_institution WHERE id = $1', [
          inst.id,
        ]),
      ).rejects.toMatchObject({ code: '23001' });
      await client.query('ROLLBACK TO SAVEPOINT delete_restrict_inst');

      await client.query('SAVEPOINT update_restrict_fac');
      await expect(
        client.query('UPDATE faculty SET id = $1 WHERE id = $2', [
          fac.id + 5000,
          fac.id,
        ]),
      ).rejects.toMatchObject({ code: '23001' });
      await client.query('ROLLBACK TO SAVEPOINT update_restrict_fac');

      await client.query('SAVEPOINT delete_restrict_fac');
      await expect(
        client.query('DELETE FROM faculty WHERE id = $1', [fac.id]),
      ).rejects.toMatchObject({ code: '23001' });
      await client.query('ROLLBACK TO SAVEPOINT delete_restrict_fac');

      await client.query('ROLLBACK');

      await service.deleteDepartment({ staffUserId }, dept.id, dept.version);
      await service.deleteFaculty({ staffUserId }, fac.id, fac.version);
      await service.deleteInstitution({ staffUserId }, inst.id, inst.version);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });

  it('protects fixed rows from updates, reparenting, and deletion without recording history', async () => {
    const beforeInstHistory = await prisma.changeHistory.count({
      where: {
        recordType: 'EDUCATIONAL_INSTITUTION',
        recordId: FIXED_OFFICE.institution.id,
      },
    });
    const beforeFacHistory = await prisma.changeHistory.count({
      where: { recordType: 'FACULTY', recordId: FIXED_OFFICE.faculty.id },
    });

    const otherInst = await service.createInstitution(
      { staffUserId },
      { name: 'Other Institution', institutionType: 'PRIVATE_UNIVERSITY' },
    );

    await expect(
      service.updateInstitution({ staffUserId }, FIXED_OFFICE.institution.id, {
        expectedVersion: 1,
        name: 'Modified Zagazig',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FIXED_RECORD_PROTECTED });

    await expect(
      service.deleteInstitution(
        { staffUserId },
        FIXED_OFFICE.institution.id,
        1,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.FIXED_RECORD_PROTECTED });

    await expect(
      service.updateFaculty({ staffUserId }, FIXED_OFFICE.faculty.id, {
        expectedVersion: 1,
        institutionId: otherInst.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FIXED_RECORD_PROTECTED });

    await expect(
      service.updateFaculty({ staffUserId }, FIXED_OFFICE.faculty.id, {
        expectedVersion: 1,
        name: 'Modified FCI',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FIXED_RECORD_PROTECTED });

    await expect(
      service.deleteFaculty({ staffUserId }, FIXED_OFFICE.faculty.id, 1),
    ).rejects.toMatchObject({ code: ERROR_CODES.FIXED_RECORD_PROTECTED });

    expect(
      await prisma.changeHistory.count({
        where: {
          recordType: 'EDUCATIONAL_INSTITUTION',
          recordId: FIXED_OFFICE.institution.id,
        },
      }),
    ).toBe(beforeInstHistory);
    expect(
      await prisma.changeHistory.count({
        where: { recordType: 'FACULTY', recordId: FIXED_OFFICE.faculty.id },
      }),
    ).toBe(beforeFacHistory);

    const fixedDept = await service.createDepartment(
      { staffUserId },
      { facultyId: FIXED_OFFICE.faculty.id, name: 'Information Systems' },
    );
    expect(fixedDept.facultyId).toBe(FIXED_OFFICE.faculty.id);
    await service.deleteDepartment(
      { staffUserId },
      fixedDept.id,
      fixedDept.version,
    );
  });

  it('rejects deleting in-use entries, records deletion history for unused entries, and rolls back when history fails', async () => {
    const inst = await service.createInstitution(
      { staffUserId },
      { name: 'Helwan University', institutionType: 'PUBLIC_UNIVERSITY' },
    );
    const fac = await service.createFaculty(
      { staffUserId },
      { institutionId: inst.id, name: 'Faculty of Computing' },
    );

    await expect(
      service.deleteInstitution({ staffUserId }, inst.id, inst.version),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

    await service.deleteFaculty({ staffUserId }, fac.id, fac.version);
    const facHistory = await prisma.changeHistory.findMany({
      where: { recordType: 'FACULTY', recordId: fac.id },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    });
    expect(facHistory.map((row) => row.action)).toEqual(['DELETED', 'CREATED']);
    expect(facHistory[0]).toMatchObject({
      actorKind: 'STAFF',
      staffUserId,
      after: null,
    });
    expect(facHistory[0].before).toMatchObject({
      id: fac.id,
      name: 'Faculty of Computing',
    });

    const admin = new Client({ connectionString: database.url });
    await admin.connect();
    try {
      await admin.query(
        'REVOKE INSERT ON change_history FROM graduate_runtime',
      );

      await expect(
        service.createInstitution(
          { staffUserId },
          { name: 'Rolled Back Univ', institutionType: 'OTHER' },
        ),
      ).rejects.toThrow();
      expect(
        await prisma.educationalInstitution.findFirst({
          where: { name: 'Rolled Back Univ' },
        }),
      ).toBeNull();

      await expect(
        service.updateInstitution({ staffUserId }, inst.id, {
          expectedVersion: inst.version,
          name: 'Should Roll Back',
        }),
      ).rejects.toThrow();
      expect(
        await prisma.educationalInstitution.findUniqueOrThrow({
          where: { id: inst.id },
        }),
      ).toMatchObject({ name: 'Helwan University', version: inst.version });

      await expect(
        service.deleteInstitution({ staffUserId }, inst.id, inst.version),
      ).rejects.toThrow();
      expect(
        await prisma.educationalInstitution.findUnique({
          where: { id: inst.id },
        }),
      ).not.toBeNull();
    } finally {
      await admin.query('GRANT INSERT ON change_history TO graduate_runtime');
      await admin.end();
    }

    await service.deleteInstitution({ staffUserId }, inst.id, inst.version);
  });

  it('allows only one of two competing versioned updates to commit', async () => {
    const inst = await service.createInstitution(
      { staffUserId },
      { name: 'Competing Updates Univ', institutionType: 'PRIVATE_UNIVERSITY' },
    );

    const results = await Promise.allSettled([
      service.updateInstitution({ staffUserId }, inst.id, {
        expectedVersion: 1,
        name: 'Winner Name A',
      }),
      service.updateInstitution({ staffUserId }, inst.id, {
        expectedVersion: 1,
        name: 'Winner Name B',
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { code: ERROR_CODES.STALE_VERSION } });

    const stored = await prisma.educationalInstitution.findUniqueOrThrow({
      where: { id: inst.id },
    });
    expect(stored.version).toBe(2);
    expect(
      await prisma.changeHistory.count({
        where: { recordType: 'EDUCATIONAL_INSTITUTION', recordId: inst.id },
      }),
    ).toBe(2);
  });

  it('fails fixed-office verification when the fixed faculty or institution is altered or deleted', async () => {
    await withPremigrationDatabase(async (dbUrl) => {
      const deployResult = await runPrismaDeploy(dbUrl);
      expect(deployResult.code).toBe(0);

      const admin = new Client({ connectionString: dbUrl });
      const isolatedPrisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: dbUrl }),
      });
      await admin.connect();
      try {
        await expect(
          assertFixedOfficeHierarchy(isolatedPrisma),
        ).resolves.toBeUndefined();

        await admin.query(
          `UPDATE faculty SET name = 'Tampered Faculty' WHERE id = 1`,
        );
        await expect(
          assertFixedOfficeHierarchy(isolatedPrisma),
        ).rejects.toThrow(/fixed/i);

        await admin.query(`DELETE FROM faculty WHERE id = 1`);
        await expect(
          assertFixedOfficeHierarchy(isolatedPrisma),
        ).rejects.toThrow(/fixed/i);
      } finally {
        await isolatedPrisma.$disconnect();
        await admin.end();
      }
    });
  });
});

async function withPremigrationDatabase(
  work: (databaseUrl: string) => Promise<void>,
): Promise<void> {
  const serverUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!serverUrl) {
    throw new Error('TEST_DATABASE_URL or DATABASE_URL must be set');
  }

  const dbName = `project_graduate_test_mig_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const adminUrl = replaceDatabaseName(serverUrl, dbName);

  await withClient(serverUrl, (client) =>
    client.query(`CREATE DATABASE ${quoteIdentifier(dbName)}`),
  );

  try {
    await withClient(adminUrl, async (client) => {
      for (const migration of PRE_PROVISIONING_MIGRATIONS) {
        const sql = await readFile(
          join(PROJECT_ROOT, 'prisma/migrations', migration, 'migration.sql'),
          'utf8',
        );
        await client.query(sql);
      }
    });

    for (const migration of PRE_PROVISIONING_MIGRATIONS) {
      const resolved = await runPrismaResolveApplied(adminUrl, migration);
      if (resolved.code !== 0) {
        throw new Error(
          `prisma migrate resolve failed for ${migration}: ${resolved.output}`,
        );
      }
    }

    await work(adminUrl);
  } finally {
    await withClient(serverUrl, async (client) => {
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [dbName],
      );
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)}`);
    }).catch(() => undefined);
  }
}

async function runPrismaResolveApplied(
  migrationDatabaseUrl: string,
  migrationName: string,
): Promise<{ code: number | null; output: string }> {
  return spawnCommand(
    process.execPath,
    [
      PRISMA_CLI,
      'migrate',
      'resolve',
      '--applied',
      migrationName,
      '--config',
      'prisma7.config.ts',
    ],
    migrationDatabaseUrl,
  );
}

async function runPrismaDeploy(
  migrationDatabaseUrl: string,
): Promise<{ code: number | null; output: string }> {
  return spawnCommand(
    NPM_COMMAND,
    ['run', 'prisma:deploy', '--silent'],
    migrationDatabaseUrl,
  );
}

function spawnCommand(
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

async function withClient<T>(
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

function replaceDatabaseName(connectionString: string, name: string): string {
  const parsed = new URL(connectionString);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
