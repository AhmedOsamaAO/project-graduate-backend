import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import { ChangeHistoryService } from '../../src/change-history/change-history.service';
import { ApiError } from '../../src/common/errors/api-error';
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
  runPrismaDeploy,
  withAdminClient,
  withPremigrationDatabase,
  type TestDatabase,
} from '../support/test-database';

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

    const fixedInstitution = await service.getInstitution(
      FIXED_OFFICE.institution.id,
    );
    expect(fixedInstitution).toMatchObject({
      id: 1,
      name: 'Zagazig University',
      institutionType: 'PUBLIC_UNIVERSITY',
      version: 1,
    });
    expect(fixedInstitution).not.toHaveProperty('isFixedOffice');

    const fixedFaculty = await service.getFaculty(FIXED_OFFICE.faculty.id);
    expect(fixedFaculty).toMatchObject({
      id: 1,
      institutionId: 1,
      name: 'Faculty of Computer and Information',
      version: 1,
    });
    expect(fixedFaculty).not.toHaveProperty('isFixedOffice');

    const createdInstitution = await service.createInstitution(
      { staffUserId },
      { name: 'Ain Shams University', institutionType: 'PUBLIC_UNIVERSITY' },
    );
    expect(createdInstitution.id).toBeGreaterThanOrEqual(2);

    const createdFaculty = await service.createFaculty(
      { staffUserId },
      { institutionId: createdInstitution.id, name: 'Faculty of Science' },
    );
    expect(createdFaculty.id).toBeGreaterThanOrEqual(2);

    await service.deleteFaculty(
      { staffUserId },
      createdFaculty.id,
      createdFaculty.version,
    );
    await service.deleteInstitution(
      { staffUserId },
      createdInstitution.id,
      createdInstitution.version,
    );
  });

  it('rejects fixed-office migration when reserved id = 1 has a conflicting institution without overwriting it', async () => {
    await withPremigrationDatabase(
      PRE_PROVISIONING_MIGRATIONS,
      async (dbUrl) => {
        await withAdminClient(dbUrl, async (admin) => {
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
        });
      },
    );
  });

  it('rejects fixed-office migration when reserved faculty id = 1 or fixed name at non-reserved id conflicts without overwriting', async () => {
    await withPremigrationDatabase(
      PRE_PROVISIONING_MIGRATIONS,
      async (dbUrl) => {
        await withAdminClient(dbUrl, async (admin) => {
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
        });
      },
    );

    await withPremigrationDatabase(
      PRE_PROVISIONING_MIGRATIONS,
      async (dbUrl) => {
        await withAdminClient(dbUrl, async (admin) => {
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
        });
      },
    );
  });

  it('succeeds idempotently on matching fixed rows and advances sequences without rewinding higher or uncalled sequences', async () => {
    await withPremigrationDatabase(
      PRE_PROVISIONING_MIGRATIONS,
      async (dbUrl) => {
        await withAdminClient(dbUrl, async (admin) => {
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
        });
      },
    );

    await withPremigrationDatabase(
      PRE_PROVISIONING_MIGRATIONS,
      async (dbUrl) => {
        await withAdminClient(dbUrl, async (admin) => {
          await admin.query(
            `ALTER SEQUENCE educational_institution_id_seq RESTART WITH 100`,
          );

          const deployResult = await runPrismaDeploy(dbUrl);
          expect(deployResult.code).toBe(0);

          const nextInst = await admin.query<{ nextval: string }>(
            `SELECT nextval('educational_institution_id_seq')::text AS nextval`,
          );
          expect(Number(nextInst.rows[0].nextval)).toBe(100);

          const nextFac = await admin.query<{ nextval: string }>(
            `SELECT nextval('faculty_id_seq')::text AS nextval`,
          );
          expect(Number(nextFac.rows[0].nextval)).toBe(2);
        });
      },
    );
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
    const beforeInstHistory = (
      await service.getInstitutionHistory(FIXED_OFFICE.institution.id)
    ).total;
    const beforeFacHistory = (
      await service.getFacultyHistory(FIXED_OFFICE.faculty.id)
    ).total;

    const otherInst = await service.createInstitution(
      { staffUserId },
      { name: 'Other Institution', institutionType: 'PRIVATE_UNIVERSITY' },
    );

    try {
      await expect(
        service.updateInstitution(
          { staffUserId },
          FIXED_OFFICE.institution.id,
          {
            expectedVersion: 1,
            name: 'Modified Zagazig',
          },
        ),
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
        (await service.getInstitutionHistory(FIXED_OFFICE.institution.id))
          .total,
      ).toBe(beforeInstHistory);
      expect(
        (await service.getFacultyHistory(FIXED_OFFICE.faculty.id)).total,
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
    } finally {
      await service.deleteInstitution(
        { staffUserId },
        otherInst.id,
        otherInst.version,
      );
    }
  });

  it('allows reparenting an unreferenced non-fixed faculty, blocks reparenting when referenced by departments, and permits renaming while referenced', async () => {
    const instA = await service.createInstitution(
      { staffUserId },
      { name: 'Reparent Source Univ', institutionType: 'PUBLIC_UNIVERSITY' },
    );
    const instB = await service.createInstitution(
      { staffUserId },
      { name: 'Reparent Target Univ', institutionType: 'PRIVATE_UNIVERSITY' },
    );
    let fac = await service.createFaculty(
      { staffUserId },
      { institutionId: instA.id, name: 'Faculty of Arts' },
    );
    let deptVersion: number | null = null;
    let deptId: number | null = null;

    try {
      fac = await service.updateFaculty({ staffUserId }, fac.id, {
        expectedVersion: fac.version,
        institutionId: instB.id,
      });
      expect(fac).toMatchObject({ institutionId: instB.id, version: 2 });
      expect(await service.getFaculty(fac.id)).toMatchObject({
        institutionId: instB.id,
        version: 2,
      });

      const reparentHistory = await service.getFacultyHistory(fac.id);
      expect(reparentHistory.items[0]).toMatchObject({
        action: 'UPDATED',
        before: { institutionId: instA.id },
        after: { institutionId: instB.id },
      });

      const dept = await service.createDepartment(
        { staffUserId },
        { facultyId: fac.id, name: 'History Department' },
      );
      deptId = dept.id;
      deptVersion = dept.version;

      await expect(
        service.updateFaculty({ staffUserId }, fac.id, {
          expectedVersion: fac.version,
          institutionId: instA.id,
        }),
      ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

      expect(await service.getFaculty(fac.id)).toMatchObject({
        institutionId: instB.id,
        version: 2,
      });
      expect((await service.getFacultyHistory(fac.id)).total).toBe(2);

      fac = await service.updateFaculty({ staffUserId }, fac.id, {
        expectedVersion: fac.version,
        name: 'Faculty of Arts and Humanities',
      });
      expect(fac.version).toBe(3);

      fac = await service.updateFaculty({ staffUserId }, fac.id, {
        expectedVersion: fac.version,
        institutionId: instB.id,
        name: 'Faculty of Humanities',
      });
      expect(fac.version).toBe(4);

      await service.deleteDepartment({ staffUserId }, deptId, deptVersion);
      deptId = null;

      fac = await service.updateFaculty({ staffUserId }, fac.id, {
        expectedVersion: fac.version,
        institutionId: instA.id,
      });
      expect(fac).toMatchObject({ institutionId: instA.id, version: 5 });
    } finally {
      if (deptId !== null && deptVersion !== null) {
        await service.deleteDepartment({ staffUserId }, deptId, deptVersion);
      }
      await service.deleteFaculty({ staffUserId }, fac.id, fac.version);
      await service.deleteInstitution({ staffUserId }, instB.id, instB.version);
      await service.deleteInstitution({ staffUserId }, instA.id, instA.version);
    }
  });

  it('serializes concurrent faculty reparenting against child department creation', async () => {
    const instA = await service.createInstitution(
      { staffUserId },
      { name: 'Race Source Univ', institutionType: 'PUBLIC_UNIVERSITY' },
    );
    const instB = await service.createInstitution(
      { staffUserId },
      { name: 'Race Target Univ', institutionType: 'PRIVATE_UNIVERSITY' },
    );
    const fac = await service.createFaculty(
      { staffUserId },
      { institutionId: instA.id, name: 'Concurrent Faculty' },
    );

    try {
      const [reparent, createDept] = await Promise.allSettled([
        service.updateFaculty({ staffUserId }, fac.id, {
          expectedVersion: fac.version,
          institutionId: instB.id,
        }),
        service.createDepartment(
          { staffUserId },
          { facultyId: fac.id, name: 'Concurrent Dept' },
        ),
      ]);

      const currentFac = await service.getFaculty(fac.id);
      const depts = (await service.listDepartments({ facultyId: fac.id }))
        .items;

      if (reparent.status === 'rejected') {
        expect(reparent.reason).toBeInstanceOf(ApiError);
        expect([
          ERROR_CODES.RECORD_IN_USE,
          ERROR_CODES.RETRYABLE_CONFLICT,
        ]).toContain((reparent.reason as ApiError).code);
        expect(createDept.status).toBe('fulfilled');
        expect(currentFac.institutionId).toBe(instA.id);
        expect(depts).toHaveLength(1);
      } else {
        expect(currentFac.institutionId).toBe(instB.id);
        expect(currentFac.version).toBe(2);
        if (createDept.status === 'rejected') {
          expect(createDept.reason).toMatchObject({
            code: ERROR_CODES.RETRYABLE_CONFLICT,
          });
        }
      }
    } finally {
      const currentFac = await service.getFaculty(fac.id);
      const depts = (await service.listDepartments({ facultyId: fac.id }))
        .items;
      for (const dept of depts) {
        await service.deleteDepartment({ staffUserId }, dept.id, dept.version);
      }
      await service.deleteFaculty({ staffUserId }, fac.id, currentFac.version);
      await service.deleteInstitution({ staffUserId }, instB.id, instB.version);
      await service.deleteInstitution({ staffUserId }, instA.id, instA.version);
    }
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
    const facHistory = await service.getFacultyHistory(fac.id);
    expect(facHistory.items.map((row) => row.action)).toEqual([
      'DELETED',
      'CREATED',
    ]);
    expect(facHistory.items[0]).toMatchObject({
      actorKind: 'STAFF',
      staffUser: { id: staffUserId },
      after: null,
      before: {
        id: fac.id,
        name: 'Faculty of Computing',
      },
    });

    await withAdminClient(database.url, async (admin) => {
      await admin.query(
        'REVOKE INSERT ON change_history FROM graduate_runtime',
      );
      try {
        await expect(
          service.createInstitution(
            { staffUserId },
            { name: 'Rolled Back Univ', institutionType: 'OTHER' },
          ),
        ).rejects.toThrow();
        expect(
          (await service.listInstitutions({ search: 'Rolled Back Univ' }))
            .items,
        ).toEqual([]);

        await expect(
          service.updateInstitution({ staffUserId }, inst.id, {
            expectedVersion: inst.version,
            name: 'Should Roll Back',
          }),
        ).rejects.toThrow();
        expect(await service.getInstitution(inst.id)).toMatchObject({
          name: 'Helwan University',
          version: inst.version,
        });

        await expect(
          service.deleteInstitution({ staffUserId }, inst.id, inst.version),
        ).rejects.toThrow();
        expect(await service.getInstitution(inst.id)).toMatchObject({
          id: inst.id,
          name: 'Helwan University',
          version: inst.version,
        });
      } finally {
        await admin.query('GRANT INSERT ON change_history TO graduate_runtime');
      }
    });

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

    const stored = await service.getInstitution(inst.id);
    expect(stored.version).toBe(2);
    expect((await service.getInstitutionHistory(inst.id)).total).toBe(2);

    await service.deleteInstitution({ staffUserId }, inst.id, stored.version);
  });

  it('fails fixed-office verification when the fixed faculty or institution is altered or deleted', async () => {
    const disposable = await createTestDatabase();
    const runtimePrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: disposable.runtimeUrl }),
    });
    try {
      await withAdminClient(disposable.url, async (admin) => {
        await expect(
          assertFixedOfficeHierarchy(runtimePrisma),
        ).resolves.toBeUndefined();

        await admin.query(
          `UPDATE educational_institution SET name = 'Tampered University' WHERE id = 1`,
        );
        await expect(assertFixedOfficeHierarchy(runtimePrisma)).rejects.toThrow(
          /fixed/i,
        );

        await admin.query(
          `UPDATE educational_institution SET name = 'Zagazig University' WHERE id = 1`,
        );
        await admin.query(
          `UPDATE faculty SET name = 'Tampered Faculty' WHERE id = 1`,
        );
        await expect(assertFixedOfficeHierarchy(runtimePrisma)).rejects.toThrow(
          /fixed/i,
        );

        await admin.query(`DELETE FROM faculty WHERE id = 1`);
        await expect(assertFixedOfficeHierarchy(runtimePrisma)).rejects.toThrow(
          /fixed/i,
        );

        await admin.query(`DELETE FROM educational_institution WHERE id = 1`);
        await expect(assertFixedOfficeHierarchy(runtimePrisma)).rejects.toThrow(
          /fixed/i,
        );
      });
    } finally {
      await runtimePrisma.$disconnect();
      await disposable.drop();
    }
  });
});
