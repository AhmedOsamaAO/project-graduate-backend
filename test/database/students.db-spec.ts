import { PrismaPg } from '@prisma/adapter-pg';
import { ChangeHistoryService } from '../../src/change-history/change-history.service';
import { ApiError } from '../../src/common/errors/api-error';
import { ERROR_CODES } from '../../src/common/errors/error-codes';
import {
  MilitaryStatus,
  PrismaClient,
} from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TransactionRunner } from '../../src/prisma/transaction-runner';
import { StaffAccounts } from '../../src/staff-access/staff-accounts';
import { StudentArchiveGuardRegistry } from '../../src/students/student-archive-guard';
import { StudentsService } from '../../src/students/students.service';
import {
  createTestDatabase,
  withAdminClient,
  type TestDatabase,
} from '../support/test-database';

describe('students and archive guard seam (db)', () => {
  let database: TestDatabase;
  let prisma: PrismaClient;
  let archiveGuards: StudentArchiveGuardRegistry;
  let service: StudentsService;
  let staffUserId: number;

  beforeAll(async () => {
    database = await createTestDatabase();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: database.runtimeUrl }),
    });
    const historyService = new ChangeHistoryService(
      prisma as unknown as PrismaService,
    );
    archiveGuards = new StudentArchiveGuardRegistry();
    service = new StudentsService(
      prisma as unknown as PrismaService,
      historyService,
      archiveGuards,
    );
    const accounts = new StaffAccounts(prisma);
    const staff = await accounts.provision(
      { attribution: 'students db test' },
      {
        username: 'students.db.staff',
        fullName: 'Students DB Staff',
        password: 'students db valid password',
      },
    );
    staffUserId = staff.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.drop();
  });

  it('enforces student table structure without degree or department columns and restricts runtime delete/truncate', async () => {
    await withAdminClient(database.url, async (admin) => {
      const { rows: columns } = await admin.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'student'
         ORDER BY ordinal_position`,
      );
      const columnNames = columns.map((row) => row.column_name);
      expect(columnNames).toEqual([
        'id',
        'full_name',
        'national_id',
        'phone',
        'birth_date',
        'address',
        'military_status',
        'selected_photo_document_id',
        'archived_at',
        'version',
        'created_at',
        'updated_at',
      ]);
      expect(columnNames).not.toContain('degree_level');
      expect(columnNames).not.toContain('degree_name');
      expect(columnNames).not.toContain('graduate_department_id');
      expect(columnNames).not.toContain('photo_url');
      expect(columnNames).not.toContain('deleted_at');

      // CHECK constraints reject malformed rows even via raw SQL
      await expect(
        admin.query(
          `INSERT INTO student (full_name, national_id, updated_at) VALUES ('   ', '29901011234567', CURRENT_TIMESTAMP)`,
        ),
      ).rejects.toThrow();
      await expect(
        admin.query(
          `INSERT INTO student (full_name, national_id, updated_at) VALUES ('Valid Name', '1234', CURRENT_TIMESTAMP)`,
        ),
      ).rejects.toThrow();
      await expect(
        admin.query(
          `INSERT INTO student (full_name, national_id, phone, updated_at) VALUES ('Valid Name', '29901011234567', '   ', CURRENT_TIMESTAMP)`,
        ),
      ).rejects.toThrow();
      await expect(
        admin.query(
          `INSERT INTO student (full_name, national_id, selected_photo_document_id, updated_at) VALUES ('Valid Name', '29901011234567', 0, CURRENT_TIMESTAMP)`,
        ),
      ).rejects.toThrow();
      await expect(
        admin.query(
          `INSERT INTO student (full_name, national_id, version, updated_at) VALUES ('Valid Name', '29901011234567', 0, CURRENT_TIMESTAMP)`,
        ),
      ).rejects.toThrow();
    });

    const created = await service.createStudent(
      { staffUserId },
      { fullName: 'Runtime Check Student', nationalId: '30102021234567' },
    );

    // Runtime role has no DELETE or TRUNCATE privileges on student
    await expect(
      prisma.$executeRaw`DELETE FROM student WHERE id = ${created.id}`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE student'),
    ).rejects.toThrow();
  });

  it('persists calendar dates without shift, allows field clearing and ID correction, and rolls back when history fails', async () => {
    const created = await service.createStudent(
      { staffUserId },
      {
        fullName: '  طارق أحمد  ',
        nationalId: '٠٠١١٢٢٣٣٤٤٥٥٦٦',
        phone: '01001234567',
        birthDate: '1997-03-21',
        address: 'Zagazig, Sharqia',
        militaryStatus: MilitaryStatus.COMPLETED,
      },
    );

    expect(created).toMatchObject({
      fullName: 'طارق أحمد',
      nationalId: '00112233445566',
      phone: '01001234567',
      birthDate: '1997-03-21',
      address: 'Zagazig, Sharqia',
      militaryStatus: 'COMPLETED',
      selectedPhotoDocumentId: null,
      archivedAt: null,
      version: 1,
    });

    const updated = await service.updateStudent({ staffUserId }, created.id, {
      expectedVersion: created.version,
      nationalId: '00112233445567',
      phone: null,
      birthDate: null,
      militaryStatus: MilitaryStatus.EXEMPTED,
    });

    expect(updated).toMatchObject({
      id: created.id,
      nationalId: '00112233445567',
      phone: null,
      birthDate: null,
      militaryStatus: 'EXEMPTED',
      version: 2,
    });

    // History failure rolls back student mutation atomically
    await withAdminClient(database.url, async (admin) => {
      await admin.query(
        'REVOKE INSERT ON change_history FROM graduate_runtime',
      );
      try {
        await expect(
          service.createStudent(
            { staffUserId },
            { fullName: 'Rolled Back', nationalId: '30909091234567' },
          ),
        ).rejects.toThrow();

        expect(
          await prisma.student.findUnique({
            where: { nationalId: '30909091234567' },
          }),
        ).toBeNull();

        await expect(
          service.updateStudent({ staffUserId }, updated.id, {
            expectedVersion: updated.version,
            fullName: 'Should Roll Back',
          }),
        ).rejects.toThrow();

        expect(await service.getStudent(updated.id)).toMatchObject({
          fullName: 'طارق أحمد',
          version: updated.version,
        });
      } finally {
        await admin.query('GRANT INSERT ON change_history TO graduate_runtime');
      }
    });
  });

  it('handles simultaneous creation with the same national ID so only one succeeds and no duplicate exists', async () => {
    const results = await Promise.allSettled([
      service.createStudent(
        { staffUserId },
        { fullName: 'Race Student ASCII', nationalId: '00776655443322' },
      ),
      service.createStudent(
        { staffUserId },
        { fullName: 'Race Student Arabic', nationalId: '٠٠٧٧٦٦٥٥٤٤٣٣٢٢' },
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ApiError);
    expect((rejected[0].reason as ApiError).code).toBe(
      ERROR_CODES.STUDENT_NATIONAL_ID_EXISTS,
    );

    const rows = await prisma.student.findMany({
      where: { nationalId: '00776655443322' },
    });
    expect(rows).toHaveLength(1);
    const history = await service.getStudentHistory(rows[0].id);
    expect(history.total).toBe(1);
  });

  it('enforces optimistic concurrency across competing versioned edits', async () => {
    const created = await service.createStudent(
      { staffUserId },
      { fullName: 'Version Race', nationalId: '29505051234567' },
    );

    const results = await Promise.allSettled([
      service.updateStudent({ staffUserId }, created.id, {
        expectedVersion: 1,
        fullName: 'Winner A',
      }),
      service.updateStudent({ staffUserId }, created.id, {
        expectedVersion: 1,
        fullName: 'Winner B',
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected');
    expect(failed?.status).toBe('rejected');
    if (failed?.status === 'rejected') {
      expect(failed.reason).toMatchObject({
        code: ERROR_CODES.STALE_VERSION,
      });
    }

    const stored = await service.getStudent(created.id);
    expect(stored.version).toBe(2);
    expect((await service.getStudentHistory(created.id)).total).toBe(2);
  });

  it('enforces archive visibility, duplicate archived-ID conflict details, and full identity/history restoration', async () => {
    const first = await service.createStudent(
      { staffUserId },
      { fullName: 'Heba Adel', nationalId: '00443322110099' },
    );
    const second = await service.createStudent(
      { staffUserId },
      { fullName: 'Second Student', nationalId: '00443322110088' },
    );

    const archived = await service.archiveStudent(
      { staffUserId },
      first.id,
      first.version,
    );
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.version).toBe(2);

    // Ordinary lookups hide archived student
    await expect(service.getStudent(first.id)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    });
    await expect(service.getStudentHistory(first.id)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    });
    expect(
      (await service.listStudents({ nationalId: '00443322110099' })).items,
    ).toEqual([]);

    // Explicit archive queries reveal archived student
    expect(
      (
        await service.listStudents({
          archiveStatus: 'ARCHIVED',
          nationalId: '٠٠٤٤٣٣٢٢١١٠٠٩٩',
        })
      ).items.map((row) => row.id),
    ).toEqual([first.id]);
    await expect(
      service.getStudent(first.id, { includeArchived: true }),
    ).resolves.toMatchObject({ id: first.id, version: 2 });

    // Creating or updating another student with the archived ID identifies the archived record
    await expect(
      service.createStudent(
        { staffUserId },
        { fullName: 'Duplicate Create', nationalId: '00443322110099' },
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODES.STUDENT_NATIONAL_ID_ARCHIVED,
      response: {
        code: ERROR_CODES.STUDENT_NATIONAL_ID_ARCHIVED,
        details: {
          studentId: first.id,
          fullName: 'Heba Adel',
          nationalId: '00443322110099',
          archivedAt: archived.archivedAt,
          version: archived.version,
          requiresRestore: true,
        },
      },
    });

    await expect(
      service.updateStudent({ staffUserId }, second.id, {
        expectedVersion: second.version,
        nationalId: '00443322110099',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.STUDENT_NATIONAL_ID_ARCHIVED,
    });

    // Stale version on restore fails
    await expect(
      service.restoreStudent({ staffUserId }, first.id, 1),
    ).rejects.toMatchObject({ code: ERROR_CODES.STALE_VERSION });

    const restored = await service.restoreStudent(
      { staffUserId },
      first.id,
      archived.version,
    );
    expect(restored).toMatchObject({
      id: first.id,
      nationalId: '00443322110099',
      archivedAt: null,
      version: 3,
    });

    const history = await service.getStudentHistory(first.id);
    expect(history.items.map((entry) => entry.action)).toEqual([
      'RESTORED',
      'ARCHIVED',
      'CREATED',
    ]);
  });

  it('protects archiving with registered archive guards and blocks dependent mutations via assertActiveStudentInTx', async () => {
    const student = await service.createStudent(
      { staffUserId },
      { fullName: 'Guarded Student', nationalId: '30303031234567' },
    );

    const transactions = new TransactionRunner(prisma);

    // Dependent transaction succeeds while active
    await expect(
      transactions.run(student.id, (tx, id) =>
        service.assertActiveStudentInTx(tx, id),
      ),
    ).resolves.toMatchObject({ id: student.id, archivedAt: null });

    // Archive guard blocks archival and leaves student active
    const unregister = archiveGuards.register({
      name: 'db-test-guard',
      async assertCanArchive(tx, studentId) {
        const row = await tx.student.findUnique({ where: { id: studentId } });
        if (row) {
          throw new ApiError(
            409,
            ERROR_CODES.RECORD_IN_USE,
            'Guard blocked archiving inside transaction',
          );
        }
      },
    });

    try {
      await expect(
        service.archiveStudent({ staffUserId }, student.id, student.version),
      ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });
      expect(await service.getStudent(student.id)).toMatchObject({
        archivedAt: null,
        version: 1,
      });
    } finally {
      unregister();
    }

    // Archival succeeds once guard clears, then assertActiveStudentInTx blocks dependent writes
    const archived = await service.archiveStudent(
      { staffUserId },
      student.id,
      student.version,
    );
    await expect(
      transactions.run(student.id, (tx, id) =>
        service.assertActiveStudentInTx(tx, id),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.STUDENT_ARCHIVED });

    // Restore allows dependent writes again and serializes safely against concurrent archival
    const restored = await service.restoreStudent(
      { staffUserId },
      student.id,
      archived.version,
    );

    const [archiveOutcome, dependentOutcome] = await Promise.allSettled([
      service.archiveStudent({ staffUserId }, student.id, restored.version),
      transactions.run(student.id, async (tx, id) => {
        const active = await service.assertActiveStudentInTx(tx, id);
        return active.archivedAt;
      }),
    ]);

    expect(archiveOutcome.status).toBe('fulfilled');
    if (dependentOutcome.status === 'fulfilled') {
      expect(dependentOutcome.value).toBeNull();
    } else {
      expect(dependentOutcome.reason).toBeInstanceOf(ApiError);
      expect((dependentOutcome.reason as ApiError).code).toBe(
        ERROR_CODES.STUDENT_ARCHIVED,
      );
    }
  });
});
