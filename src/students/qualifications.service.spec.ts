import { ChangeHistoryService } from '../change-history/change-history.service';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  DegreeLevel,
  EquivalencyStatus,
  InstitutionType,
  Prisma,
  type Department,
  type EducationalInstitution,
  type Faculty,
  type HistoryAction,
  type HistoryActorKind,
  type HistoryRecordType,
  type Student,
  type StudentQualification,
} from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { QualificationMutationGuardRegistry } from './qualification-mutation-guard';
import { QualificationsService } from './qualifications.service';
import { StudentArchiveGuardRegistry } from './student-archive-guard';
import { StudentsService } from './students.service';

interface HistoryRow {
  id: number;
  recordType: HistoryRecordType;
  recordId: number | null;
  action: HistoryAction;
  actorKind: HistoryActorKind;
  staffUserId: number | null;
  operatorAttribution: string | null;
  occurredAt: Date;
  before: unknown;
  after: unknown;
}

function adapterError(code: string) {
  return Object.assign(new Error(`Adapter error ${code}`), {
    cause: { originalCode: code },
  });
}

function createFakeQualificationsPrisma() {
  const baseNow = new Date('2026-11-27T10:00:00.000Z');
  let tick = 0;
  const nextTimestamp = () => new Date(baseNow.getTime() + ++tick * 1000);

  let state = {
    institutions: [
      {
        id: 1,
        name: 'Zagazig University',
        institutionType: InstitutionType.PUBLIC_UNIVERSITY,
        version: 1,
        createdAt: baseNow,
        updatedAt: baseNow,
      },
      {
        id: 2,
        name: 'Cairo University',
        institutionType: InstitutionType.PUBLIC_UNIVERSITY,
        version: 1,
        createdAt: baseNow,
        updatedAt: baseNow,
      },
    ] as EducationalInstitution[],
    faculties: [
      {
        id: 1,
        institutionId: 1,
        name: 'Faculty of Computer and Information',
        version: 1,
        createdAt: baseNow,
        updatedAt: baseNow,
      },
      {
        id: 2,
        institutionId: 2,
        name: 'Faculty of Engineering',
        version: 1,
        createdAt: baseNow,
        updatedAt: baseNow,
      },
    ] as Faculty[],
    departments: [
      {
        id: 1,
        facultyId: 1,
        name: 'Computer Science',
        version: 1,
        createdAt: baseNow,
        updatedAt: baseNow,
      },
      {
        id: 2,
        facultyId: 2,
        name: 'Computer Engineering',
        version: 1,
        createdAt: baseNow,
        updatedAt: baseNow,
      },
    ] as Department[],
    students: [] as Student[],
    qualifications: [] as StudentQualification[],
    history: [] as HistoryRow[],
    nextStudentId: 1,
    nextQualificationId: 1,
    nextHistoryId: 1,
  };

  let queuedRetryErrors: Error[] = [];

  const staffUsers = new Map([
    [10, { id: 10, username: 'staff.one', fullName: 'Staff One' }],
  ]);

  const sortQualifications = (
    rows: StudentQualification[],
    orderBy: Array<Record<string, unknown>> = [
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
  ) =>
    [...rows].sort((left, right) => {
      for (const clause of orderBy) {
        const [field, spec] = Object.entries(clause)[0];
        const direction =
          typeof spec === 'string'
            ? (spec as 'asc' | 'desc')
            : (spec as { sort: 'asc' | 'desc'; nulls?: 'last' }).sort;
        const nullsLast =
          typeof spec === 'object' &&
          spec !== null &&
          (spec as { nulls?: string }).nulls === 'last';

        const a = left[field as keyof StudentQualification];
        const b = right[field as keyof StudentQualification];
        if (nullsLast && (a === null || b === null)) {
          if (a === null && b === null) continue;
          return a === null ? 1 : -1;
        }
        let cmp = 0;
        if (typeof a === 'number' && typeof b === 'number') {
          cmp = a - b;
        } else if (a instanceof Date && b instanceof Date) {
          cmp = a.getTime() - b.getTime();
        } else {
          cmp = String(a ?? '').localeCompare(String(b ?? ''));
        }
        if (cmp !== 0) {
          return direction === 'asc' ? cmp : -cmp;
        }
      }
      return 0;
    });

  const matchesQualificationWhere = (
    row: StudentQualification,
    where: Record<string, unknown> = {},
  ): boolean => {
    if ('studentId' in where && row.studentId !== where.studentId) {
      return false;
    }
    if ('degreeLevel' in where && row.degreeLevel !== where.degreeLevel) {
      return false;
    }
    if (
      'equivalencyStatus' in where &&
      row.equivalencyStatus !== where.equivalencyStatus
    ) {
      return false;
    }
    if ('archivedAt' in where) {
      const filter = where.archivedAt;
      if (filter === null && row.archivedAt !== null) {
        return false;
      }
      if (
        typeof filter === 'object' &&
        filter !== null &&
        'not' in filter &&
        filter.not === null &&
        row.archivedAt === null
      ) {
        return false;
      }
    }
    return true;
  };

  const makeClient = (getWorking: () => typeof state) => ({
    $queryRaw: () => Promise.resolve([]),
    educationalInstitution: {
      findUnique: ({ where }: { where: { id: number } }) =>
        Promise.resolve(
          getWorking().institutions.find((row) => row.id === where.id) ?? null,
        ),
    },
    faculty: {
      findUnique: ({ where }: { where: { id: number } }) =>
        Promise.resolve(
          getWorking().faculties.find((row) => row.id === where.id) ?? null,
        ),
    },
    department: {
      findUnique: ({
        where,
        include,
        select,
      }: {
        where: { id: number };
        include?: { faculty?: boolean };
        select?: Record<string, unknown>;
      }) => {
        const dept = getWorking().departments.find(
          (row) => row.id === where.id,
        );
        if (!dept) {
          return Promise.resolve(null);
        }
        const faculty = getWorking().faculties.find(
          (f) => f.id === dept.facultyId,
        )!;
        if (include?.faculty || (select && 'faculty' in select)) {
          return Promise.resolve(structuredClone({ ...dept, faculty }));
        }
        return Promise.resolve(structuredClone(dept));
      },
    },
    student: {
      count: () => Promise.resolve(getWorking().students.length),
      findMany: () =>
        Promise.resolve(getWorking().students.map((s) => structuredClone(s))),
      findUnique: ({
        where,
      }: {
        where: { id?: number; nationalId?: string };
      }) => {
        const found = getWorking().students.find((row) =>
          where.id !== undefined
            ? row.id === where.id
            : row.nationalId === where.nationalId,
        );
        return Promise.resolve(found ? structuredClone(found) : null);
      },
      create: ({
        data,
      }: {
        data: {
          fullName: string;
          nationalId: string;
          phone: string | null;
          birthDate: Date | null;
          address: string | null;
          militaryStatus: Student['militaryStatus'];
          selectedPhotoDocumentId: number | null;
          archivedAt: Date | null;
        };
      }) => {
        const working = getWorking();
        const now = nextTimestamp();
        const created: Student = {
          id: working.nextStudentId++,
          fullName: data.fullName,
          nationalId: data.nationalId,
          phone: data.phone,
          birthDate: data.birthDate,
          address: data.address,
          militaryStatus: data.militaryStatus,
          selectedPhotoDocumentId: data.selectedPhotoDocumentId,
          archivedAt: data.archivedAt,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        working.students.push(created);
        return Promise.resolve(structuredClone(created));
      },
      update: ({
        where,
        data,
      }: {
        where: { id: number };
        data: {
          archivedAt?: Date | null;
          version?: { increment: number };
        };
      }) => {
        const working = getWorking();
        const row = working.students.find((s) => s.id === where.id)!;
        if (data.archivedAt !== undefined) row.archivedAt = data.archivedAt;
        if (data.version?.increment) row.version += data.version.increment;
        row.updatedAt = nextTimestamp();
        return Promise.resolve(structuredClone(row));
      },
    },
    studentQualification: {
      count: ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
        Promise.resolve(
          getWorking().qualifications.filter((row) =>
            matchesQualificationWhere(row, where),
          ).length,
        ),
      findMany: ({
        where = {},
        orderBy,
        skip = 0,
        take,
      }: {
        where?: Record<string, unknown>;
        orderBy?: Array<Record<string, unknown>>;
        skip?: number;
        take?: number;
      } = {}) => {
        const filtered = getWorking().qualifications.filter((row) =>
          matchesQualificationWhere(row, where),
        );
        const sorted = sortQualifications(filtered, orderBy);
        const end = take === undefined ? undefined : skip + take;
        return Promise.resolve(
          sorted.slice(skip, end).map((row) => structuredClone(row)),
        );
      },
      findUnique: ({
        where,
        include,
        select,
      }: {
        where: { id: number };
        include?: { student?: boolean | { select?: Record<string, boolean> } };
        select?: Record<string, unknown>;
      }) => {
        const found = getWorking().qualifications.find(
          (row) => row.id === where.id,
        );
        if (!found) {
          return Promise.resolve(null);
        }
        if (include?.student || (select && 'student' in select)) {
          const student = getWorking().students.find(
            (s) => s.id === found.studentId,
          )!;
          return Promise.resolve(
            structuredClone({
              ...found,
              student: { archivedAt: student.archivedAt },
            }),
          );
        }
        return Promise.resolve(structuredClone(found));
      },
      create: ({
        data,
      }: {
        data: {
          studentId: number;
          degreeLevel: DegreeLevel;
          qualificationName: string | null;
          institutionId: number | null;
          facultyId: number | null;
          departmentId: number | null;
          graduationYear: number | null;
          overallGrade: string | null;
          equivalencyStatus: EquivalencyStatus;
          equivalencyDecisionNumber: string | null;
          equivalencyDecisionDate: Date | null;
          archivedAt: Date | null;
        };
      }) => {
        const working = getWorking();
        const now = nextTimestamp();
        const created: StudentQualification = {
          id: working.nextQualificationId++,
          studentId: data.studentId,
          degreeLevel: data.degreeLevel,
          qualificationName: data.qualificationName,
          institutionId: data.institutionId,
          facultyId: data.facultyId,
          departmentId: data.departmentId,
          graduationYear: data.graduationYear,
          overallGrade: data.overallGrade,
          equivalencyStatus: data.equivalencyStatus,
          equivalencyDecisionNumber: data.equivalencyDecisionNumber,
          equivalencyDecisionDate: data.equivalencyDecisionDate,
          archivedAt: data.archivedAt,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        working.qualifications.push(created);
        return Promise.resolve(structuredClone(created));
      },
      update: ({
        where,
        data,
      }: {
        where: { id: number };
        data: Partial<StudentQualification> & {
          version?: { increment: number };
        };
      }) => {
        const working = getWorking();
        const row = working.qualifications.find((q) => q.id === where.id)!;
        if (data.degreeLevel !== undefined) row.degreeLevel = data.degreeLevel;
        if (data.qualificationName !== undefined) {
          row.qualificationName = data.qualificationName;
        }
        if (data.institutionId !== undefined) {
          row.institutionId = data.institutionId;
        }
        if (data.facultyId !== undefined) row.facultyId = data.facultyId;
        if (data.departmentId !== undefined) {
          row.departmentId = data.departmentId;
        }
        if (data.graduationYear !== undefined) {
          row.graduationYear = data.graduationYear;
        }
        if (data.overallGrade !== undefined) {
          row.overallGrade = data.overallGrade;
        }
        if (data.equivalencyStatus !== undefined) {
          row.equivalencyStatus = data.equivalencyStatus;
        }
        if (data.equivalencyDecisionNumber !== undefined) {
          row.equivalencyDecisionNumber = data.equivalencyDecisionNumber;
        }
        if (data.equivalencyDecisionDate !== undefined) {
          row.equivalencyDecisionDate = data.equivalencyDecisionDate;
        }
        if (data.archivedAt !== undefined) row.archivedAt = data.archivedAt;
        if (data.version?.increment) row.version += data.version.increment;
        row.updatedAt = nextTimestamp();
        return Promise.resolve(structuredClone(row));
      },
    },
    changeHistory: {
      count: ({
        where,
      }: {
        where?: { recordType?: HistoryRecordType; recordId?: number };
      }) =>
        Promise.resolve(
          getWorking().history.filter(
            (row) =>
              (where?.recordType === undefined ||
                row.recordType === where.recordType) &&
              (where?.recordId === undefined ||
                row.recordId === where.recordId),
          ).length,
        ),
      findMany: ({
        where,
        skip = 0,
        take = 20,
      }: {
        where?: { recordType?: HistoryRecordType; recordId?: number };
        skip?: number;
        take?: number;
      }) => {
        const filtered = getWorking().history.filter(
          (row) =>
            (where?.recordType === undefined ||
              row.recordType === where.recordType) &&
            (where?.recordId === undefined || row.recordId === where.recordId),
        );
        const sorted = [...filtered].sort((left, right) => {
          const diff = right.occurredAt.getTime() - left.occurredAt.getTime();
          return diff !== 0 ? diff : right.id - left.id;
        });
        return Promise.resolve(
          sorted.slice(skip, skip + take).map((row) => ({
            ...row,
            staffUser:
              row.staffUserId !== null
                ? (staffUsers.get(row.staffUserId) ?? null)
                : null,
          })),
        );
      },
      create: ({
        data,
      }: {
        data: {
          recordType: HistoryRecordType;
          recordId: number;
          action: HistoryAction;
          actorKind: HistoryActorKind;
          staffUserId: number;
          before: unknown;
          after: unknown;
        };
      }) => {
        const working = getWorking();
        const created: HistoryRow = {
          id: working.nextHistoryId++,
          recordType: data.recordType,
          recordId: data.recordId,
          action: data.action,
          actorKind: data.actorKind,
          staffUserId: data.staffUserId,
          operatorAttribution: null,
          occurredAt: nextTimestamp(),
          before: data.before === Prisma.DbNull ? null : data.before,
          after: data.after === Prisma.DbNull ? null : data.after,
        };
        working.history.push(created);
        return Promise.resolve({ id: created.id });
      },
    },
    $transaction: async (arg: unknown) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      if (queuedRetryErrors.length > 0) {
        const queued = queuedRetryErrors.shift()!;
        throw queued;
      }
      const working = structuredClone(state);
      const tx = makeClient(() => working);
      const result = await (arg as (client: typeof tx) => Promise<unknown>)(tx);
      state = working;
      return result;
    },
  });

  return {
    prisma: makeClient(() => state) as unknown as PrismaService,
    queueRetryErrors: (errors: Error[]) => {
      queuedRetryErrors = [...errors];
    },
  };
}

describe('QualificationsService', () => {
  const actor = { staffUserId: 10 };
  const fixedNow = new Date('2026-11-27T10:00:00.000Z');

  async function makeContext() {
    const fake = createFakeQualificationsPrisma();
    const historyService = new ChangeHistoryService(fake.prisma);
    const studentArchiveGuards = new StudentArchiveGuardRegistry();
    const studentsService = new StudentsService(
      fake.prisma,
      historyService,
      studentArchiveGuards,
      { now: () => fixedNow },
    );
    const mutationGuards = new QualificationMutationGuardRegistry();
    const service = new QualificationsService(
      fake.prisma,
      historyService,
      studentsService,
      mutationGuards,
      { now: () => fixedNow },
    );
    const student = await studentsService.createStudent(actor, {
      fullName: 'Nadia Hassan',
      nationalId: '29901011234567',
    });
    return {
      service,
      studentsService,
      mutationGuards,
      student,
      ...fake,
    };
  }

  it('creates minimal qualifications, allows multiple qualifications per degree level, and resolves awarding hierarchy from deepest reference', async () => {
    const { service, student } = await makeContext();

    const minimal = await service.createQualification(actor, student.id, {
      degreeLevel: DegreeLevel.BACHELOR,
    });
    expect(minimal).toMatchObject({
      studentId: student.id,
      degreeLevel: 'BACHELOR',
      qualificationName: null,
      institutionId: null,
      facultyId: null,
      departmentId: null,
      graduationYear: null,
      overallGrade: null,
      equivalencyStatus: 'NOT_ASSESSED',
      equivalencyDecisionNumber: null,
      equivalencyDecisionDate: null,
      archivedAt: null,
      version: 1,
    });

    // Second bachelor for the same student is allowed, institution-only
    const secondBachelor = await service.createQualification(
      actor,
      student.id,
      {
        degreeLevel: DegreeLevel.BACHELOR,
        qualificationName: 'B.Sc. Mathematics',
        institutionId: 2,
        graduationYear: 2020,
        overallGrade: 'Good (78.5%)',
      },
    );
    expect(secondBachelor).toMatchObject({
      degreeLevel: 'BACHELOR',
      institutionId: 2,
      facultyId: null,
      departmentId: null,
      graduationYear: 2020,
      overallGrade: 'Good (78.5%)',
    });

    // Faculty-only resolves institutionId
    const facultyOnly = await service.createQualification(actor, student.id, {
      degreeLevel: DegreeLevel.PROFESSIONAL,
      facultyId: 1,
    });
    expect(facultyOnly).toMatchObject({
      institutionId: 1,
      facultyId: 1,
      departmentId: null,
    });

    // Department-only resolves facultyId and institutionId
    const departmentOnly = await service.createQualification(
      actor,
      student.id,
      {
        degreeLevel: DegreeLevel.MASTER,
        departmentId: 2,
      },
    );
    expect(departmentOnly).toMatchObject({
      institutionId: 2,
      facultyId: 2,
      departmentId: 2,
    });

    const list = await service.listStudentQualifications(student.id);
    expect(list.total).toBe(4);
    expect(list.items.map((item) => item.id)).toEqual([
      minimal.id,
      secondBachelor.id,
      facultyOnly.id,
      departmentOnly.id,
    ]);
  });

  it('rejects conflicting awarding references and missing catalog records without silent overwrites', async () => {
    const { service, student } = await makeContext();

    // Missing catalog IDs -> 404
    await expect(
      service.createQualification(actor, student.id, {
        degreeLevel: DegreeLevel.BACHELOR,
        institutionId: 999,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    await expect(
      service.createQualification(actor, student.id, {
        degreeLevel: DegreeLevel.BACHELOR,
        facultyId: 999,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    await expect(
      service.createQualification(actor, student.id, {
        degreeLevel: DegreeLevel.BACHELOR,
        departmentId: 999,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    // Faculty 1 belongs to Institution 1, not Institution 2
    await expect(
      service.createQualification(actor, student.id, {
        degreeLevel: DegreeLevel.BACHELOR,
        institutionId: 2,
        facultyId: 1,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.QUALIFICATION_HIERARCHY_CONFLICT,
    });

    // Department 1 belongs to Faculty 1, not Faculty 2
    await expect(
      service.createQualification(actor, student.id, {
        degreeLevel: DegreeLevel.BACHELOR,
        facultyId: 2,
        departmentId: 1,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.QUALIFICATION_HIERARCHY_CONFLICT,
    });

    // Explicit null ancestor with non-null descendant
    await expect(
      service.createQualification(actor, student.id, {
        degreeLevel: DegreeLevel.BACHELOR,
        institutionId: null,
        facultyId: 1,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.QUALIFICATION_HIERARCHY_CONFLICT,
    });

    // Update conflict checks and cross-branch deepest-reference resolution
    const created = await service.createQualification(actor, student.id, {
      degreeLevel: DegreeLevel.BACHELOR,
      departmentId: 1, // inst 1, fac 1, dept 1
    });

    // Changing ancestor without clearing/updating existing descendants conflicts
    await expect(
      service.updateQualification(actor, created.id, {
        expectedVersion: created.version,
        institutionId: 2,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.QUALIFICATION_HIERARCHY_CONFLICT,
    });

    await expect(
      service.updateQualification(actor, created.id, {
        expectedVersion: created.version,
        facultyId: 2,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.QUALIFICATION_HIERARCHY_CONFLICT,
    });

    await expect(
      service.updateQualification(actor, created.id, {
        expectedVersion: created.version,
        institutionId: null,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.QUALIFICATION_HIERARCHY_CONFLICT,
    });

    // Explicit conflicting ancestor alongside deepest supplied reference is rejected
    await expect(
      service.updateQualification(actor, created.id, {
        expectedVersion: created.version,
        institutionId: 1,
        departmentId: 2,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.QUALIFICATION_HIERARCHY_CONFLICT,
    });

    // Supplying deepest departmentId alone resolves its ancestors cleanly
    const switchedByDept = await service.updateQualification(
      actor,
      created.id,
      {
        expectedVersion: created.version,
        departmentId: 2, // inst 2, fac 2
      },
    );
    expect(switchedByDept).toMatchObject({
      institutionId: 2,
      facultyId: 2,
      departmentId: 2,
      version: 2,
    });

    // Supplying facultyId while clearing departmentId resolves faculty's institutionId
    const switchedByFaculty = await service.updateQualification(
      actor,
      created.id,
      {
        expectedVersion: switchedByDept.version,
        facultyId: 1,
        departmentId: null,
      },
    );
    expect(switchedByFaculty).toMatchObject({
      institutionId: 1,
      facultyId: 1,
      departmentId: null,
      version: 3,
    });

    // Supplying facultyId alone on an institution+faculty record resolves new institutionId
    const switchedFacultyAgain = await service.updateQualification(
      actor,
      created.id,
      {
        expectedVersion: switchedByFaculty.version,
        facultyId: 2,
      },
    );
    expect(switchedFacultyAgain).toMatchObject({
      institutionId: 2,
      facultyId: 2,
      departmentId: null,
      version: 4,
    });

    // Explicit clearing to institution-only works, then deepest departmentId resolves ancestors
    const institutionOnly = await service.updateQualification(
      actor,
      created.id,
      {
        expectedVersion: switchedFacultyAgain.version,
        facultyId: null,
      },
    );
    expect(institutionOnly).toMatchObject({
      institutionId: 2,
      facultyId: null,
      departmentId: null,
      version: 5,
    });

    const resolvedBack = await service.updateQualification(actor, created.id, {
      expectedVersion: institutionOnly.version,
      departmentId: 1, // resolves to inst 1, fac 1, dept 1
    });
    expect(resolvedBack).toMatchObject({
      institutionId: 1,
      facultyId: 1,
      departmentId: 1,
      version: 6,
    });
  });

  it('preserves equivalency decision details across status transitions until explicitly replaced or cleared', async () => {
    const { service, student } = await makeContext();

    // Direct entry as APPROVED succeeds when decision details are provided
    const approved = await service.createQualification(actor, student.id, {
      degreeLevel: DegreeLevel.MASTER,
      equivalencyStatus: EquivalencyStatus.APPROVED,
      equivalencyDecisionNumber: 'DEC-100',
      equivalencyDecisionDate: '2026-10-01',
    });
    expect(approved).toMatchObject({
      equivalencyStatus: 'APPROVED',
      equivalencyDecisionNumber: 'DEC-100',
      equivalencyDecisionDate: '2026-10-01',
    });

    // Correct status to PENDING without supplying decision fields -> existing details persist
    const pending = await service.updateQualification(actor, approved.id, {
      expectedVersion: approved.version,
      equivalencyStatus: EquivalencyStatus.PENDING,
    });
    expect(pending).toMatchObject({
      equivalencyStatus: 'PENDING',
      equivalencyDecisionNumber: 'DEC-100',
      equivalencyDecisionDate: '2026-10-01',
      version: 2,
    });

    // Switching back to APPROVED without resending details uses the persisted details
    const reApproved = await service.updateQualification(actor, approved.id, {
      expectedVersion: pending.version,
      equivalencyStatus: EquivalencyStatus.APPROVED,
    });
    expect(reApproved).toMatchObject({
      equivalencyStatus: 'APPROVED',
      equivalencyDecisionNumber: 'DEC-100',
      equivalencyDecisionDate: '2026-10-01',
      version: 3,
    });

    // Explicitly clearing details while APPROVED fails validation
    await expect(
      service.updateQualification(actor, approved.id, {
        expectedVersion: reApproved.version,
        equivalencyDecisionNumber: null,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    // Switching to REJECTED while explicitly clearing details succeeds
    const rejected = await service.updateQualification(actor, approved.id, {
      expectedVersion: reApproved.version,
      equivalencyStatus: EquivalencyStatus.REJECTED,
      equivalencyDecisionNumber: null,
      equivalencyDecisionDate: null,
    });
    expect(rejected).toMatchObject({
      equivalencyStatus: 'REJECTED',
      equivalencyDecisionNumber: null,
      equivalencyDecisionDate: null,
      version: 4,
    });

    // Moving back to APPROVED now requires decision details again
    await expect(
      service.updateQualification(actor, approved.id, {
        expectedVersion: rejected.version,
        equivalencyStatus: EquivalencyStatus.APPROVED,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
  });

  it('enforces independent archive/restore and blocks qualification mutations when student is archived', async () => {
    const { service, studentsService, student } = await makeContext();

    const q1 = await service.createQualification(actor, student.id, {
      degreeLevel: DegreeLevel.BACHELOR,
    });
    const q2 = await service.createQualification(actor, student.id, {
      degreeLevel: DegreeLevel.MASTER,
    });

    const q1Archived = await service.archiveQualification(
      actor,
      q1.id,
      q1.version,
    );
    expect(q1Archived.archivedAt).not.toBeNull();
    expect(q1Archived.version).toBe(2);

    // Ordinary lookups hide archived qualification
    await expect(service.getQualification(q1.id)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    });
    await expect(service.getQualificationHistory(q1.id)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    });
    expect(
      (await service.listStudentQualifications(student.id)).items.map(
        (q) => q.id,
      ),
    ).toEqual([q2.id]);

    // Archived qualification blocks update and re-archive
    await expect(
      service.updateQualification(actor, q1.id, {
        expectedVersion: q1Archived.version,
        overallGrade: 'Good',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.QUALIFICATION_ARCHIVED });
    await expect(
      service.archiveQualification(actor, q1.id, q1Archived.version),
    ).rejects.toMatchObject({
      code: ERROR_CODES.QUALIFICATION_ALREADY_ARCHIVED,
    });

    // Archiving the student hides active qualification q2 from ordinary lists/get/history and blocks all mutations
    const archivedStudent = await studentsService.archiveStudent(
      actor,
      student.id,
      student.version,
    );

    await expect(
      service.listStudentQualifications(student.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
    await expect(service.getQualification(q2.id)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    });
    await expect(
      service.createQualification(actor, student.id, {
        degreeLevel: DegreeLevel.PHD,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STUDENT_ARCHIVED });
    await expect(
      service.updateQualification(actor, q2.id, {
        expectedVersion: q2.version,
        overallGrade: 'Good',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STUDENT_ARCHIVED });
    await expect(
      service.archiveQualification(actor, q2.id, q2.version),
    ).rejects.toMatchObject({ code: ERROR_CODES.STUDENT_ARCHIVED });
    await expect(
      service.restoreQualification(actor, q1.id, q1Archived.version),
    ).rejects.toMatchObject({ code: ERROR_CODES.STUDENT_ARCHIVED });

    // Explicit archive query exposes qualifications of archived student
    expect(
      (
        await service.listStudentQualifications(student.id, {
          archiveStatus: 'ALL',
          includeArchivedStudent: true,
        })
      ).items.map((q) => q.id),
    ).toEqual([q1.id, q2.id]);

    // Restoring the student does NOT restore individually archived qualification q1
    await studentsService.restoreStudent(
      actor,
      student.id,
      archivedStudent.version,
    );
    await expect(service.getQualification(q1.id)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    });
    await expect(service.getQualification(q2.id)).resolves.toMatchObject({
      id: q2.id,
      archivedAt: null,
    });

    // Now q1 can be restored explicitly
    const q1Restored = await service.restoreQualification(
      actor,
      q1.id,
      q1Archived.version,
    );
    expect(q1Restored).toMatchObject({
      id: q1.id,
      archivedAt: null,
      version: 3,
    });
    await expect(
      service.restoreQualification(actor, q1.id, q1Restored.version),
    ).rejects.toMatchObject({
      code: ERROR_CODES.QUALIFICATION_NOT_ARCHIVED,
    });

    const history = await service.getQualificationHistory(q1.id);
    expect(history.items.map((entry) => entry.action)).toEqual([
      'RESTORED',
      'ARCHIVED',
      'CREATED',
    ]);
  });

  it('invokes QualificationMutationGuardRegistry on update and archive inside the transaction', async () => {
    const { service, mutationGuards, student } = await makeContext();
    const created = await service.createQualification(actor, student.id, {
      degreeLevel: DegreeLevel.BACHELOR,
    });

    const contexts: string[] = [];
    const unregister = mutationGuards.register({
      name: 'test-enrollment-guard',
      assertCanMutate(_tx, context) {
        contexts.push(
          context.kind === 'UPDATE'
            ? `UPDATE:${context.before.degreeLevel}->${context.next.degreeLevel}`
            : `ARCHIVE:${context.qualificationId}`,
        );
        return Promise.reject(
          new ApiError(
            409,
            ERROR_CODES.RECORD_IN_USE,
            'Referenced by enrollment',
          ),
        );
      },
    });

    try {
      await expect(
        service.updateQualification(actor, created.id, {
          expectedVersion: created.version,
          degreeLevel: DegreeLevel.MASTER,
        }),
      ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

      await expect(
        service.archiveQualification(actor, created.id, created.version),
      ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

      expect(contexts).toEqual([
        'UPDATE:BACHELOR->MASTER',
        `ARCHIVE:${created.id}`,
      ]);
      expect(await service.getQualification(created.id)).toMatchObject({
        degreeLevel: 'BACHELOR',
        archivedAt: null,
        version: 1,
      });
    } finally {
      unregister();
    }

    const updated = await service.updateQualification(actor, created.id, {
      expectedVersion: created.version,
      degreeLevel: DegreeLevel.MASTER,
    });
    expect(updated.degreeLevel).toBe('MASTER');
  });

  it('retries serialization conflicts up to 3 attempts preserving expectedVersion and fails with STALE_VERSION when version mismatches', async () => {
    const { service, student, queueRetryErrors } = await makeContext();
    const created = await service.createQualification(actor, student.id, {
      degreeLevel: DegreeLevel.BACHELOR,
    });

    queueRetryErrors([adapterError('40001'), adapterError('40001')]);
    const retried = await service.updateQualification(actor, created.id, {
      expectedVersion: 1,
      qualificationName: 'Retried Success',
    });
    expect(retried).toMatchObject({
      qualificationName: 'Retried Success',
      version: 2,
    });

    await expect(
      service.updateQualification(actor, created.id, {
        expectedVersion: 1,
        qualificationName: 'Stale',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STALE_VERSION });

    queueRetryErrors([
      adapterError('40001'),
      adapterError('40001'),
      adapterError('40001'),
    ]);
    await expect(
      service.updateQualification(actor, created.id, {
        expectedVersion: retried.version,
        qualificationName: 'Exhausted',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.RETRYABLE_CONFLICT });
  });
});
