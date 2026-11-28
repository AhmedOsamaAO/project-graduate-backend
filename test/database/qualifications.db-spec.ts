import { PrismaPg } from '@prisma/adapter-pg';
import { ChangeHistoryService } from '../../src/change-history/change-history.service';
import { ApiError } from '../../src/common/errors/api-error';
import { ERROR_CODES } from '../../src/common/errors/error-codes';
import {
  DegreeLevel,
  EquivalencyStatus,
  InstitutionType,
  PrismaClient,
} from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FIXED_OFFICE } from '../../src/reference-data/fixed-office';
import { ReferenceDataService } from '../../src/reference-data/reference-data.service';
import { StaffAccounts } from '../../src/staff-access/staff-accounts';
import { QualificationMutationGuardRegistry } from '../../src/students/qualification-mutation-guard';
import { QualificationsService } from '../../src/students/qualifications.service';
import { StudentArchiveGuardRegistry } from '../../src/students/student-archive-guard';
import { StudentsService } from '../../src/students/students.service';
import {
  createTestDatabase,
  withAdminClient,
  type TestDatabase,
} from '../support/test-database';

describe('qualifications, equivalency, and mutation guard seam (db)', () => {
  let database: TestDatabase;
  let prisma: PrismaClient;
  let referenceData: ReferenceDataService;
  let studentsService: StudentsService;
  let mutationGuards: QualificationMutationGuardRegistry;
  let service: QualificationsService;
  let staffUserId: number;

  beforeAll(async () => {
    database = await createTestDatabase();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: database.runtimeUrl }),
    });
    const historyService = new ChangeHistoryService(
      prisma as unknown as PrismaService,
    );
    referenceData = new ReferenceDataService(
      prisma as unknown as PrismaService,
      historyService,
    );
    studentsService = new StudentsService(
      prisma as unknown as PrismaService,
      historyService,
      new StudentArchiveGuardRegistry(),
    );
    mutationGuards = new QualificationMutationGuardRegistry();
    service = new QualificationsService(
      prisma as unknown as PrismaService,
      historyService,
      studentsService,
      mutationGuards,
    );
    const accounts = new StaffAccounts(prisma);
    const staff = await accounts.provision(
      { attribution: 'qualifications db test' },
      {
        username: 'qualifications.db.staff',
        fullName: 'Qualifications DB Staff',
        password: 'qualifications db valid password',
      },
    );
    staffUserId = staff.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.drop();
  });

  it('enforces student_qualification schema constraints, composite FKs, immutable owner trigger, and runtime privileges', async () => {
    const instA = await referenceData.createInstitution(
      { staffUserId },
      {
        name: 'DB Constraint Univ A',
        institutionType: InstitutionType.PUBLIC_UNIVERSITY,
      },
    );
    const instB = await referenceData.createInstitution(
      { staffUserId },
      {
        name: 'DB Constraint Univ B',
        institutionType: InstitutionType.PRIVATE_UNIVERSITY,
      },
    );
    const facA = await referenceData.createFaculty(
      { staffUserId },
      { institutionId: instA.id, name: 'DB Faculty A' },
    );
    const facB = await referenceData.createFaculty(
      { staffUserId },
      { institutionId: instB.id, name: 'DB Faculty B' },
    );
    const deptA = await referenceData.createDepartment(
      { staffUserId },
      { facultyId: facA.id, name: 'DB Dept A' },
    );

    const studentA = await studentsService.createStudent(
      { staffUserId },
      { fullName: 'Owner Student A', nationalId: '29801011234561' },
    );
    const studentB = await studentsService.createStudent(
      { staffUserId },
      { fullName: 'Owner Student B', nationalId: '29801011234562' },
    );

    await withAdminClient(database.url, async (admin) => {
      const { rows: columns } = await admin.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'student_qualification'
         ORDER BY ordinal_position`,
      );
      expect(columns.map((row) => row.column_name)).toEqual([
        'id',
        'student_id',
        'degree_level',
        'qualification_name',
        'institution_id',
        'faculty_id',
        'department_id',
        'graduation_year',
        'overall_grade',
        'equivalency_status',
        'equivalency_decision_number',
        'equivalency_decision_date',
        'archived_at',
        'version',
        'created_at',
        'updated_at',
      ]);

      // Malformed rows rejected by PostgreSQL CHECK and composite FK constraints
      for (const badSql of [
        `INSERT INTO student_qualification (student_id, degree_level, qualification_name, updated_at)
         VALUES (${studentA.id}, 'BACHELOR', '   ', CURRENT_TIMESTAMP)`,
        `INSERT INTO student_qualification (student_id, degree_level, overall_grade, updated_at)
         VALUES (${studentA.id}, 'BACHELOR', '   ', CURRENT_TIMESTAMP)`,
        `INSERT INTO student_qualification (student_id, degree_level, graduation_year, updated_at)
         VALUES (${studentA.id}, 'BACHELOR', 0, CURRENT_TIMESTAMP)`,
        `INSERT INTO student_qualification (student_id, degree_level, faculty_id, updated_at)
         VALUES (${studentA.id}, 'BACHELOR', ${facA.id}, CURRENT_TIMESTAMP)`,
        `INSERT INTO student_qualification (student_id, degree_level, department_id, updated_at)
         VALUES (${studentA.id}, 'BACHELOR', ${deptA.id}, CURRENT_TIMESTAMP)`,
        `INSERT INTO student_qualification (student_id, degree_level, equivalency_status, equivalency_decision_number, updated_at)
         VALUES (${studentA.id}, 'BACHELOR', 'APPROVED', 'EQ-1', CURRENT_TIMESTAMP)`,
        `INSERT INTO student_qualification (student_id, degree_level, equivalency_status, equivalency_decision_date, updated_at)
         VALUES (${studentA.id}, 'BACHELOR', 'APPROVED', '2026-01-01', CURRENT_TIMESTAMP)`,
        `INSERT INTO student_qualification (student_id, degree_level, equivalency_decision_number, updated_at)
         VALUES (${studentA.id}, 'BACHELOR', '   ', CURRENT_TIMESTAMP)`,
        `INSERT INTO student_qualification (student_id, degree_level, version, updated_at)
         VALUES (${studentA.id}, 'BACHELOR', 0, CURRENT_TIMESTAMP)`,
        // Composite FK rejects mismatched (faculty_id, institution_id)
        `INSERT INTO student_qualification (student_id, degree_level, institution_id, faculty_id, updated_at)
         VALUES (${studentA.id}, 'BACHELOR', ${instB.id}, ${facA.id}, CURRENT_TIMESTAMP)`,
        // Composite FK rejects mismatched (department_id, faculty_id)
        `INSERT INTO student_qualification (student_id, degree_level, institution_id, faculty_id, department_id, updated_at)
         VALUES (${studentA.id}, 'BACHELOR', ${instB.id}, ${facB.id}, ${deptA.id}, CURRENT_TIMESTAMP)`,
      ]) {
        await expect(admin.query(badSql)).rejects.toThrow();
      }
    });

    const created = await service.createQualification(
      { staffUserId },
      studentA.id,
      { degreeLevel: DegreeLevel.BACHELOR },
    );

    // Immutable owner trigger prevents reassigning student_id even as admin
    await withAdminClient(database.url, async (admin) => {
      await expect(
        admin.query(
          `UPDATE student_qualification SET student_id = $1 WHERE id = $2`,
          [studentB.id, created.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    // Runtime role has no DELETE or TRUNCATE privileges on student_qualification
    await expect(
      prisma.$executeRaw`DELETE FROM student_qualification WHERE id = ${created.id}`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE student_qualification'),
    ).rejects.toThrow();
  });

  it('resolves deepest awarding hierarchy, allows multiple per level, and protects referenced catalog entries from deletion and reparenting', async () => {
    const instA = await referenceData.createInstitution(
      { staffUserId },
      {
        name: 'Catalog Source Univ',
        institutionType: InstitutionType.PUBLIC_UNIVERSITY,
      },
    );
    const instB = await referenceData.createInstitution(
      { staffUserId },
      {
        name: 'Catalog Target Univ',
        institutionType: InstitutionType.NATIONAL_UNIVERSITY,
      },
    );
    const facA = await referenceData.createFaculty(
      { staffUserId },
      { institutionId: instA.id, name: 'Faculty With Dept' },
    );
    const facLeaf = await referenceData.createFaculty(
      { staffUserId },
      { institutionId: instA.id, name: 'Faculty Without Depts' },
    );
    const facB = await referenceData.createFaculty(
      { staffUserId },
      { institutionId: instB.id, name: 'Faculty Under B' },
    );
    const deptA = await referenceData.createDepartment(
      { staffUserId },
      { facultyId: facA.id, name: 'Referenced Dept' },
    );

    const student = await studentsService.createStudent(
      { staffUserId },
      { fullName: 'Hierarchy Student', nationalId: '29705051234567' },
    );

    // Multiple qualifications at the same level: institution-only, institution+faculty, department-only
    const qInstOnly = await service.createQualification(
      { staffUserId },
      student.id,
      {
        degreeLevel: DegreeLevel.BACHELOR,
        institutionId: instA.id,
      },
    );
    expect(qInstOnly).toMatchObject({
      institutionId: instA.id,
      facultyId: null,
      departmentId: null,
    });

    const qInstFac = await service.createQualification(
      { staffUserId },
      student.id,
      {
        degreeLevel: DegreeLevel.BACHELOR,
        institutionId: instA.id,
        facultyId: facLeaf.id,
      },
    );
    expect(qInstFac).toMatchObject({
      institutionId: instA.id,
      facultyId: facLeaf.id,
      departmentId: null,
    });

    const qDeptResolved = await service.createQualification(
      { staffUserId },
      student.id,
      {
        degreeLevel: DegreeLevel.MASTER,
        departmentId: deptA.id,
      },
    );
    expect(qDeptResolved).toMatchObject({
      institutionId: instA.id,
      facultyId: facA.id,
      departmentId: deptA.id,
    });

    // Conflicting hierarchy rejected
    await expect(
      service.createQualification({ staffUserId }, student.id, {
        degreeLevel: DegreeLevel.PHD,
        institutionId: instB.id,
        facultyId: facA.id,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.QUALIFICATION_HIERARCHY_CONFLICT,
    });

    // Catalog entries referenced by qualifications cannot be deleted or reparented, but can be renamed
    await expect(
      referenceData.deleteInstitution({ staffUserId }, instA.id, instA.version),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });
    await expect(
      referenceData.deleteFaculty({ staffUserId }, facLeaf.id, facLeaf.version),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });
    await expect(
      referenceData.deleteDepartment({ staffUserId }, deptA.id, deptA.version),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

    // facLeaf has zero departments, yet qualification reference blocks reparenting
    await expect(
      referenceData.updateFaculty({ staffUserId }, facLeaf.id, {
        expectedVersion: facLeaf.version,
        institutionId: instB.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

    // deptA is referenced by qDeptResolved, so reparenting deptA to facB is blocked
    await expect(
      referenceData.updateDepartment({ staffUserId }, deptA.id, {
        expectedVersion: deptA.version,
        facultyId: facB.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

    // Renaming remains permitted
    const renamedDept = await referenceData.updateDepartment(
      { staffUserId },
      deptA.id,
      { expectedVersion: deptA.version, name: 'Renamed Referenced Dept' },
    );
    expect(renamedDept.name).toBe('Renamed Referenced Dept');
  });

  it('persists equivalency details, enforces independent archive/restore, protects with mutation guards, and rolls back on history failure', async () => {
    const fixedDept = await referenceData.createDepartment(
      { staffUserId },
      { facultyId: FIXED_OFFICE.faculty.id, name: 'Information Systems DB' },
    );

    const student = await studentsService.createStudent(
      { staffUserId },
      {
        fullName: 'Lifecycle Qualification Student',
        nationalId: '29606061234567',
      },
    );

    const created = await service.createQualification(
      { staffUserId },
      student.id,
      {
        degreeLevel: DegreeLevel.BACHELOR,
        departmentId: fixedDept.id,
        equivalencyStatus: EquivalencyStatus.APPROVED,
        equivalencyDecisionNumber: 'EQ-2025/09',
        equivalencyDecisionDate: '2025-11-10',
      },
    );
    expect(created).toMatchObject({
      institutionId: FIXED_OFFICE.institution.id,
      facultyId: FIXED_OFFICE.faculty.id,
      departmentId: fixedDept.id,
      equivalencyStatus: 'APPROVED',
      equivalencyDecisionNumber: 'EQ-2025/09',
      equivalencyDecisionDate: '2025-11-10',
    });

    // Status change preserves decision details
    const movedToPending = await service.updateQualification(
      { staffUserId },
      created.id,
      {
        expectedVersion: created.version,
        equivalencyStatus: EquivalencyStatus.PENDING,
      },
    );
    expect(movedToPending).toMatchObject({
      equivalencyStatus: 'PENDING',
      equivalencyDecisionNumber: 'EQ-2025/09',
      equivalencyDecisionDate: '2025-11-10',
      version: 2,
    });

    // Mutation guard blocks update and archive inside transaction without partial writes
    const unregister = mutationGuards.register({
      name: 'db-qualification-guard',
      async assertCanMutate(tx, context) {
        const row = await tx.studentQualification.findUnique({
          where: { id: context.qualificationId },
        });
        if (row) {
          throw new ApiError(
            409,
            ERROR_CODES.RECORD_IN_USE,
            'Guard blocked mutation',
          );
        }
      },
    });

    try {
      await expect(
        service.updateQualification({ staffUserId }, created.id, {
          expectedVersion: movedToPending.version,
          degreeLevel: DegreeLevel.MASTER,
        }),
      ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });
      await expect(
        service.archiveQualification(
          { staffUserId },
          created.id,
          movedToPending.version,
        ),
      ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });
      expect(await service.getQualification(created.id)).toMatchObject({
        degreeLevel: 'BACHELOR',
        archivedAt: null,
        version: 2,
      });
    } finally {
      unregister();
    }

    // Archive qualification, then archive & restore student: qualification remains archived
    const archivedQual = await service.archiveQualification(
      { staffUserId },
      created.id,
      movedToPending.version,
    );
    const archivedStudent = await studentsService.archiveStudent(
      { staffUserId },
      student.id,
      student.version,
    );

    await expect(
      service.restoreQualification(
        { staffUserId },
        created.id,
        archivedQual.version,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.STUDENT_ARCHIVED });

    await studentsService.restoreStudent(
      { staffUserId },
      student.id,
      archivedStudent.version,
    );

    await expect(service.getQualification(created.id)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    });
    const restoredQual = await service.restoreQualification(
      { staffUserId },
      created.id,
      archivedQual.version,
    );
    expect(restoredQual).toMatchObject({
      archivedAt: null,
      version: 4,
    });

    // Atomic rollback on change_history failure
    await withAdminClient(database.url, async (admin) => {
      await admin.query(
        'REVOKE INSERT ON change_history FROM graduate_runtime',
      );
      try {
        await expect(
          service.createQualification({ staffUserId }, student.id, {
            degreeLevel: DegreeLevel.PHD,
          }),
        ).rejects.toThrow();

        const list = await service.listStudentQualifications(student.id);
        expect(list.total).toBe(1);

        await expect(
          service.updateQualification({ staffUserId }, restoredQual.id, {
            expectedVersion: restoredQual.version,
            overallGrade: 'Should Roll Back',
          }),
        ).rejects.toThrow();
        expect(await service.getQualification(restoredQual.id)).toMatchObject({
          overallGrade: null,
          version: restoredQual.version,
        });
      } finally {
        await admin.query('GRANT INSERT ON change_history TO graduate_runtime');
      }
    });
  });

  it('enforces optimistic concurrency and serializes concurrent student archival against qualification mutations', async () => {
    const student = await studentsService.createStudent(
      { staffUserId },
      { fullName: 'Concurrency Student', nationalId: '29404041234567' },
    );
    const qual = await service.createQualification(
      { staffUserId },
      student.id,
      { degreeLevel: DegreeLevel.BACHELOR },
    );

    const updateRace = await Promise.allSettled([
      service.updateQualification({ staffUserId }, qual.id, {
        expectedVersion: qual.version,
        overallGrade: 'Winner A',
      }),
      service.updateQualification({ staffUserId }, qual.id, {
        expectedVersion: qual.version,
        overallGrade: 'Winner B',
      }),
    ]);

    expect(updateRace.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(updateRace.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: ERROR_CODES.STALE_VERSION },
    });

    const currentQual = await service.getQualification(qual.id);
    const [archiveOutcome, createOutcome] = await Promise.allSettled([
      studentsService.archiveStudent(
        { staffUserId },
        student.id,
        student.version,
      ),
      service.createQualification({ staffUserId }, student.id, {
        degreeLevel: DegreeLevel.MASTER,
      }),
    ]);

    expect(archiveOutcome.status).toBe('fulfilled');
    if (createOutcome.status === 'fulfilled') {
      expect(
        (
          await service.listStudentQualifications(student.id, {
            includeArchivedStudent: true,
          })
        ).total,
      ).toBe(2);
    } else {
      expect(createOutcome.reason).toBeInstanceOf(ApiError);
      expect([
        ERROR_CODES.STUDENT_ARCHIVED,
        ERROR_CODES.RETRYABLE_CONFLICT,
      ]).toContain((createOutcome.reason as ApiError).code);
    }
    expect(currentQual.version).toBe(2);
  });
});
