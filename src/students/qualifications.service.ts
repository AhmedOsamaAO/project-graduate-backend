import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  appendStaffRecordHistory,
  type ChangeHistoryEntryView,
  type StaffActor,
} from '../change-history/change-history';
import { ChangeHistoryService } from '../change-history/change-history.service';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import { createPage, type PageResult } from '../common/http/page';
import type { PageQueryDto } from '../common/http/page-query.dto';
import {
  EquivalencyStatus,
  type DegreeLevel,
  type Prisma,
  type StudentQualification,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionRunner } from '../prisma/transaction-runner';
import {
  QualificationMutationGuardRegistry,
  type QualificationSnapshot,
} from './qualification-mutation-guard';
import {
  assertEquivalencyDetailsConsistent,
  buildQualificationOrderBy,
  qualificationAlreadyArchivedError,
  qualificationArchivedError,
  qualificationHierarchyConflictError,
  qualificationNotArchivedError,
  validateDegreeLevel,
  validateEquivalencyStatus,
  validateOptionalBoolean,
  validateOptionalCatalogReferenceId,
  validateOptionalDecisionDate,
  validateOptionalDecisionNumber,
  validateOptionalDegreeLevelFilter,
  validateOptionalEquivalencyStatusFilter,
  validateOptionalGraduationYear,
  validateOptionalOverallGrade,
  validateOptionalQualificationName,
  type QualificationArchiveFilter,
  type QualificationSortField,
} from './qualifications.validation';
import {
  qualificationView,
  toQualificationSnapshot,
  type QualificationView,
} from './qualifications.views';
import { StudentsService } from './students.service';
import {
  normalizePagination,
  notFoundError,
  validateArchiveFilter,
  validatePositiveInt4,
  validationError,
  type SortDirection,
} from './students.validation';

export const QUALIFICATIONS_CLOCK = Symbol('QUALIFICATIONS_CLOCK');

export interface QualificationClock {
  now(): Date;
}

export interface ListStudentQualificationsInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly degreeLevel?: DegreeLevel;
  readonly equivalencyStatus?: EquivalencyStatus;
  readonly archiveStatus?: QualificationArchiveFilter;
  readonly includeArchivedStudent?: boolean;
  readonly sortBy?: QualificationSortField;
  readonly sortOrder?: SortDirection;
}

export interface GetQualificationOptions {
  readonly includeArchived?: boolean;
}

export interface CreateQualificationInput {
  readonly degreeLevel: DegreeLevel;
  readonly qualificationName?: string | null;
  readonly institutionId?: number | null;
  readonly facultyId?: number | null;
  readonly departmentId?: number | null;
  readonly graduationYear?: number | null;
  readonly overallGrade?: string | null;
  readonly equivalencyStatus?: EquivalencyStatus;
  readonly equivalencyDecisionNumber?: string | null;
  readonly equivalencyDecisionDate?: string | null;
}

export interface UpdateQualificationInput {
  readonly expectedVersion: number;
  readonly degreeLevel?: DegreeLevel;
  readonly qualificationName?: string | null;
  readonly institutionId?: number | null;
  readonly facultyId?: number | null;
  readonly departmentId?: number | null;
  readonly graduationYear?: number | null;
  readonly overallGrade?: string | null;
  readonly equivalencyStatus?: EquivalencyStatus;
  readonly equivalencyDecisionNumber?: string | null;
  readonly equivalencyDecisionDate?: string | null;
}

export interface QualificationHistoryQueryInput extends Partial<
  Pick<PageQueryDto, 'page' | 'pageSize'>
> {
  readonly includeArchived?: boolean;
}

interface AwardingHierarchyIds {
  readonly institutionId: number | null;
  readonly facultyId: number | null;
  readonly departmentId: number | null;
}

interface AwardingHierarchyPatch {
  readonly institutionId?: number | null;
  readonly facultyId?: number | null;
  readonly departmentId?: number | null;
}

@Injectable()
export class QualificationsService {
  private readonly transactions: TransactionRunner;
  private readonly clock: QualificationClock;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly changeHistory: ChangeHistoryService,
    private readonly students: StudentsService,
    private readonly mutationGuards: QualificationMutationGuardRegistry,
    @Optional() @Inject(QUALIFICATIONS_CLOCK) clock?: QualificationClock,
  ) {
    this.transactions = new TransactionRunner(prisma);
    this.clock = clock ?? { now: () => new Date() };
  }

  async listStudentQualifications(
    studentId: number,
    query: ListStudentQualificationsInput = {},
  ): Promise<PageResult<QualificationView>> {
    const validStudentId = validatePositiveInt4(studentId, 'studentId');
    const pagination = normalizePagination(query);
    const degreeLevel = validateOptionalDegreeLevelFilter(query.degreeLevel);
    const equivalencyStatus = validateOptionalEquivalencyStatusFilter(
      query.equivalencyStatus,
    );
    const archiveStatus = validateArchiveFilter(query.archiveStatus);
    const includeArchivedStudent =
      validateOptionalBoolean(
        query.includeArchivedStudent,
        'includeArchivedStudent',
      ) ?? false;
    const orderBy = buildQualificationOrderBy(query.sortBy, query.sortOrder);

    const where: Prisma.StudentQualificationWhereInput = {
      studentId: validStudentId,
      ...(archiveStatus === 'ACTIVE' ? { archivedAt: null } : {}),
      ...(archiveStatus === 'ARCHIVED' ? { archivedAt: { not: null } } : {}),
      ...(degreeLevel !== undefined ? { degreeLevel } : {}),
      ...(equivalencyStatus !== undefined ? { equivalencyStatus } : {}),
    };

    const { total, rows } = await this.prisma.$transaction(async (tx) => {
      const student = await tx.student.findUnique({
        where: { id: validStudentId },
        select: { id: true, archivedAt: true },
      });
      if (
        !student ||
        (!includeArchivedStudent && student.archivedAt !== null)
      ) {
        throw notFoundError('Student not found');
      }

      const count = await tx.studentQualification.count({ where });
      const items = await tx.studentQualification.findMany({
        where,
        orderBy,
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
      });
      return { total: count, rows: items };
    });

    return createPage(
      rows.map(qualificationView),
      total,
      pagination.page,
      pagination.pageSize,
    );
  }

  async getQualification(
    id: number,
    options: GetQualificationOptions = {},
  ): Promise<QualificationView> {
    const validId = validatePositiveInt4(id, 'id');
    const includeArchived =
      validateOptionalBoolean(options.includeArchived, 'includeArchived') ??
      false;

    const row = await this.prisma.studentQualification.findUnique({
      where: { id: validId },
      include: { student: { select: { archivedAt: true } } },
    });
    if (!row || !isQualificationVisible(row, includeArchived)) {
      throw notFoundError('Qualification not found');
    }
    return qualificationView(row);
  }

  async createQualification(
    actor: StaffActor,
    studentId: number,
    input: CreateQualificationInput,
  ): Promise<QualificationView> {
    const validStudentId = validatePositiveInt4(studentId, 'studentId');
    const now = this.clock.now();
    const degreeLevel = validateDegreeLevel(input.degreeLevel);
    const qualificationName =
      validateOptionalQualificationName(input.qualificationName) ?? null;
    const institutionId = validateOptionalCatalogReferenceId(
      input.institutionId,
      'institutionId',
    );
    const facultyId = validateOptionalCatalogReferenceId(
      input.facultyId,
      'facultyId',
    );
    const departmentId = validateOptionalCatalogReferenceId(
      input.departmentId,
      'departmentId',
    );
    const graduationYear =
      validateOptionalGraduationYear(input.graduationYear, now) ?? null;
    const overallGrade =
      validateOptionalOverallGrade(input.overallGrade) ?? null;
    const equivalencyStatus =
      input.equivalencyStatus !== undefined
        ? validateEquivalencyStatus(input.equivalencyStatus)
        : EquivalencyStatus.NOT_ASSESSED;
    const equivalencyDecisionNumber =
      validateOptionalDecisionNumber(input.equivalencyDecisionNumber) ?? null;
    const equivalencyDecisionDate =
      validateOptionalDecisionDate(input.equivalencyDecisionDate, now) ?? null;

    assertEquivalencyDetailsConsistent(
      equivalencyStatus,
      equivalencyDecisionNumber,
      equivalencyDecisionDate,
      now,
    );

    return this.transactions.run(
      {
        studentId: validStudentId,
        degreeLevel,
        qualificationName,
        institutionId,
        facultyId,
        departmentId,
        graduationYear,
        overallGrade,
        equivalencyStatus,
        equivalencyDecisionNumber,
        equivalencyDecisionDate,
      },
      async (tx, data) => {
        await this.students.assertActiveStudentInTx(tx, data.studentId);
        const hierarchy = await resolveAwardingHierarchy(
          tx,
          { institutionId: null, facultyId: null, departmentId: null },
          {
            institutionId: data.institutionId,
            facultyId: data.facultyId,
            departmentId: data.departmentId,
          },
        );

        const created = await tx.studentQualification.create({
          data: {
            studentId: data.studentId,
            degreeLevel: data.degreeLevel,
            qualificationName: data.qualificationName,
            institutionId: hierarchy.institutionId,
            facultyId: hierarchy.facultyId,
            departmentId: hierarchy.departmentId,
            graduationYear: data.graduationYear,
            overallGrade: data.overallGrade,
            equivalencyStatus: data.equivalencyStatus,
            equivalencyDecisionNumber: data.equivalencyDecisionNumber,
            equivalencyDecisionDate: data.equivalencyDecisionDate,
            archivedAt: null,
          },
        });

        await appendStaffRecordHistory(tx, actor, {
          recordType: 'STUDENT_QUALIFICATION',
          recordId: created.id,
          action: 'CREATED',
          before: null,
          after: qualificationView(created),
        });
        return qualificationView(created);
      },
    );
  }

  async updateQualification(
    actor: StaffActor,
    id: number,
    input: UpdateQualificationInput,
  ): Promise<QualificationView> {
    const validId = validatePositiveInt4(id, 'id');
    const expectedVersion = validatePositiveInt4(
      input.expectedVersion,
      'expectedVersion',
    );
    if (
      input.degreeLevel === undefined &&
      input.qualificationName === undefined &&
      input.institutionId === undefined &&
      input.facultyId === undefined &&
      input.departmentId === undefined &&
      input.graduationYear === undefined &&
      input.overallGrade === undefined &&
      input.equivalencyStatus === undefined &&
      input.equivalencyDecisionNumber === undefined &&
      input.equivalencyDecisionDate === undefined
    ) {
      throw validationError(
        'body',
        'At least one field to update must be provided',
      );
    }

    const now = this.clock.now();
    const degreeLevel =
      input.degreeLevel !== undefined
        ? validateDegreeLevel(input.degreeLevel)
        : undefined;
    const qualificationName = validateOptionalQualificationName(
      input.qualificationName,
    );
    const institutionId = validateOptionalCatalogReferenceId(
      input.institutionId,
      'institutionId',
    );
    const facultyId = validateOptionalCatalogReferenceId(
      input.facultyId,
      'facultyId',
    );
    const departmentId = validateOptionalCatalogReferenceId(
      input.departmentId,
      'departmentId',
    );
    const graduationYear = validateOptionalGraduationYear(
      input.graduationYear,
      now,
    );
    const overallGrade = validateOptionalOverallGrade(input.overallGrade);
    const equivalencyStatus =
      input.equivalencyStatus !== undefined
        ? validateEquivalencyStatus(input.equivalencyStatus)
        : undefined;
    const equivalencyDecisionNumber = validateOptionalDecisionNumber(
      input.equivalencyDecisionNumber,
    );
    const equivalencyDecisionDate = validateOptionalDecisionDate(
      input.equivalencyDecisionDate,
      now,
    );

    return this.runVersionedMutation(
      validId,
      expectedVersion,
      {
        now,
        degreeLevel,
        qualificationName,
        institutionId,
        facultyId,
        departmentId,
        graduationYear,
        overallGrade,
        equivalencyStatus,
        equivalencyDecisionNumber,
        equivalencyDecisionDate,
      },
      async (tx, before, data) => {
        if (before.archivedAt !== null) {
          throw qualificationArchivedError(
            'Archived qualification must be restored before editing',
          );
        }

        const hierarchy = await resolveAwardingHierarchy(
          tx,
          {
            institutionId: before.institutionId,
            facultyId: before.facultyId,
            departmentId: before.departmentId,
          },
          {
            institutionId: data.institutionId,
            facultyId: data.facultyId,
            departmentId: data.departmentId,
          },
        );

        const nextFields = {
          degreeLevel: data.degreeLevel ?? before.degreeLevel,
          qualificationName:
            data.qualificationName !== undefined
              ? data.qualificationName
              : before.qualificationName,
          institutionId: hierarchy.institutionId,
          facultyId: hierarchy.facultyId,
          departmentId: hierarchy.departmentId,
          graduationYear:
            data.graduationYear !== undefined
              ? data.graduationYear
              : before.graduationYear,
          overallGrade:
            data.overallGrade !== undefined
              ? data.overallGrade
              : before.overallGrade,
          equivalencyStatus: data.equivalencyStatus ?? before.equivalencyStatus,
          equivalencyDecisionNumber:
            data.equivalencyDecisionNumber !== undefined
              ? data.equivalencyDecisionNumber
              : before.equivalencyDecisionNumber,
          equivalencyDecisionDate:
            data.equivalencyDecisionDate !== undefined
              ? data.equivalencyDecisionDate
              : before.equivalencyDecisionDate,
        };

        assertEquivalencyDetailsConsistent(
          nextFields.equivalencyStatus,
          nextFields.equivalencyDecisionNumber,
          nextFields.equivalencyDecisionDate,
          data.now,
        );

        const nextSnapshot: QualificationSnapshot = {
          id: before.id,
          studentId: before.studentId,
          ...nextFields,
          archivedAt: before.archivedAt,
          version: before.version + 1,
        };

        await this.mutationGuards.assertCanMutate(tx, {
          kind: 'UPDATE',
          qualificationId: before.id,
          studentId: before.studentId,
          before: toQualificationSnapshot(before),
          next: nextSnapshot,
        });

        const after = await tx.studentQualification.update({
          where: { id: before.id },
          data: {
            ...nextFields,
            version: { increment: 1 },
          },
        });

        await appendStaffRecordHistory(tx, actor, {
          recordType: 'STUDENT_QUALIFICATION',
          recordId: after.id,
          action: 'UPDATED',
          before: qualificationView(before),
          after: qualificationView(after),
        });
        return qualificationView(after);
      },
    );
  }

  async archiveQualification(
    actor: StaffActor,
    id: number,
    expectedVersion: number,
  ): Promise<QualificationView> {
    const validId = validatePositiveInt4(id, 'id');
    const validVersion = validatePositiveInt4(
      expectedVersion,
      'expectedVersion',
    );
    const archivedAt = this.clock.now();

    return this.runVersionedMutation(
      validId,
      validVersion,
      { archivedAt },
      async (tx, before, data) => {
        if (before.archivedAt !== null) {
          throw qualificationAlreadyArchivedError();
        }

        await this.mutationGuards.assertCanMutate(tx, {
          kind: 'ARCHIVE',
          qualificationId: before.id,
          studentId: before.studentId,
          before: toQualificationSnapshot(before),
          archivedAt: data.archivedAt,
        });

        const after = await tx.studentQualification.update({
          where: { id: before.id },
          data: {
            archivedAt: data.archivedAt,
            version: { increment: 1 },
          },
        });

        await appendStaffRecordHistory(tx, actor, {
          recordType: 'STUDENT_QUALIFICATION',
          recordId: after.id,
          action: 'ARCHIVED',
          before: qualificationView(before),
          after: qualificationView(after),
        });
        return qualificationView(after);
      },
    );
  }

  async restoreQualification(
    actor: StaffActor,
    id: number,
    expectedVersion: number,
  ): Promise<QualificationView> {
    const validId = validatePositiveInt4(id, 'id');
    const validVersion = validatePositiveInt4(
      expectedVersion,
      'expectedVersion',
    );

    return this.runVersionedMutation(
      validId,
      validVersion,
      undefined,
      async (tx, before) => {
        if (before.archivedAt === null) {
          throw qualificationNotArchivedError();
        }

        const after = await tx.studentQualification.update({
          where: { id: before.id },
          data: {
            archivedAt: null,
            version: { increment: 1 },
          },
        });

        await appendStaffRecordHistory(tx, actor, {
          recordType: 'STUDENT_QUALIFICATION',
          recordId: after.id,
          action: 'RESTORED',
          before: qualificationView(before),
          after: qualificationView(after),
        });
        return qualificationView(after);
      },
    );
  }

  async getQualificationHistory(
    id: number,
    query: QualificationHistoryQueryInput = {},
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    const validId = validatePositiveInt4(id, 'id');
    const pagination = normalizePagination(query);
    const includeArchived =
      validateOptionalBoolean(query.includeArchived, 'includeArchived') ??
      false;

    const qualification = await this.prisma.studentQualification.findUnique({
      where: { id: validId },
      select: {
        id: true,
        archivedAt: true,
        student: { select: { archivedAt: true } },
      },
    });
    if (
      !qualification ||
      !isQualificationVisible(qualification, includeArchived)
    ) {
      throw notFoundError('Qualification not found');
    }

    return this.changeHistory.listRecordHistory(
      'STUDENT_QUALIFICATION',
      validId,
      pagination,
      () => Promise.resolve(true),
    );
  }

  private async runVersionedMutation<Payload, Result>(
    id: number,
    expectedVersion: number,
    payload: Payload,
    execute: (
      tx: Prisma.TransactionClient,
      before: StudentQualification,
      payload: NoInfer<Payload>,
    ) => Promise<Result>,
  ): Promise<Result> {
    return this.transactions.run(
      { id, expectedVersion, payload },
      async (tx, original) => {
        const target = await tx.studentQualification.findUnique({
          where: { id: original.id },
          select: { id: true, studentId: true },
        });
        if (!target) {
          throw notFoundError('Qualification not found');
        }

        await this.students.assertActiveStudentInTx(tx, target.studentId);

        const before = await lockQualification(tx, original.id);
        if (!before) {
          throw notFoundError('Qualification not found');
        }
        if (before.version !== original.expectedVersion) {
          throw new ApiError(
            HttpStatus.CONFLICT,
            ERROR_CODES.STALE_VERSION,
            'Qualification record has changed; refresh and retry with the current version',
          );
        }
        return execute(tx, before, original.payload);
      },
    );
  }
}

async function lockQualification(
  tx: Prisma.TransactionClient,
  id: number,
): Promise<StudentQualification | null> {
  await tx.$queryRaw`SELECT id FROM student_qualification WHERE id = ${id} FOR UPDATE`;
  return tx.studentQualification.findUnique({ where: { id } });
}

function isQualificationVisible(
  row: {
    readonly archivedAt: Date | null;
    readonly student: { readonly archivedAt: Date | null };
  },
  includeArchived: boolean,
): boolean {
  return (
    includeArchived ||
    (row.archivedAt === null && row.student.archivedAt === null)
  );
}

async function resolveAwardingHierarchy(
  tx: Prisma.TransactionClient,
  current: AwardingHierarchyIds,
  patch: AwardingHierarchyPatch,
): Promise<AwardingHierarchyIds> {
  if (
    patch.institutionId === undefined &&
    patch.facultyId === undefined &&
    patch.departmentId === undefined
  ) {
    return current;
  }

  const suppliedDepartment =
    patch.departmentId !== undefined && patch.departmentId !== null;
  const suppliedFaculty =
    patch.facultyId !== undefined && patch.facultyId !== null;

  const rawInstitutionId =
    patch.institutionId !== undefined
      ? patch.institutionId
      : suppliedDepartment || suppliedFaculty
        ? null
        : current.institutionId;
  const rawFacultyId =
    patch.facultyId !== undefined
      ? patch.facultyId
      : suppliedDepartment
        ? null
        : current.facultyId;
  const rawDepartmentId =
    patch.departmentId !== undefined
      ? patch.departmentId
      : current.departmentId;

  if (rawInstitutionId !== null) {
    const institution = await tx.educationalInstitution.findUnique({
      where: { id: rawInstitutionId },
      select: { id: true },
    });
    if (!institution) {
      throw notFoundError('Educational institution not found');
    }
  }

  const faculty =
    rawFacultyId !== null
      ? await tx.faculty.findUnique({
          where: { id: rawFacultyId },
          select: { id: true, institutionId: true },
        })
      : null;
  if (rawFacultyId !== null && !faculty) {
    throw notFoundError('Faculty not found');
  }

  const department =
    rawDepartmentId !== null
      ? await tx.department.findUnique({
          where: { id: rawDepartmentId },
          select: {
            id: true,
            facultyId: true,
            faculty: { select: { id: true, institutionId: true } },
          },
        })
      : null;
  if (rawDepartmentId !== null && !department) {
    throw notFoundError('Department not found');
  }

  if (
    rawDepartmentId !== null &&
    (patch.facultyId === null || patch.institutionId === null)
  ) {
    throw qualificationHierarchyConflictError(
      'Cannot clear awarding institution or faculty while a department is specified',
    );
  }
  if (rawFacultyId !== null && patch.institutionId === null) {
    throw qualificationHierarchyConflictError(
      'Cannot clear awarding institution while a faculty is specified',
    );
  }

  let resolvedInstitutionId = rawInstitutionId;
  let resolvedFacultyId = rawFacultyId;
  const resolvedDepartmentId = rawDepartmentId;

  if (department) {
    if (
      resolvedFacultyId !== null &&
      department.facultyId !== resolvedFacultyId
    ) {
      throw qualificationHierarchyConflictError(
        'Supplied department does not belong to the specified faculty',
      );
    }
    resolvedFacultyId = department.facultyId;

    if (
      resolvedInstitutionId !== null &&
      department.faculty.institutionId !== resolvedInstitutionId
    ) {
      throw qualificationHierarchyConflictError(
        'Supplied department does not belong to the specified educational institution',
      );
    }
    resolvedInstitutionId = department.faculty.institutionId;
  } else if (faculty) {
    if (
      resolvedInstitutionId !== null &&
      faculty.institutionId !== resolvedInstitutionId
    ) {
      throw qualificationHierarchyConflictError(
        'Supplied faculty does not belong to the specified educational institution',
      );
    }
    resolvedInstitutionId = faculty.institutionId;
  }

  return {
    institutionId: resolvedInstitutionId,
    facultyId: resolvedFacultyId,
    departmentId: resolvedDepartmentId,
  };
}
