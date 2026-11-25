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
import type {
  MilitaryStatus,
  Prisma,
  Student,
} from '../generated/prisma/client';
import { isUniqueConstraintError } from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionRunner } from '../prisma/transaction-runner';
import {
  StudentArchiveGuardRegistry,
  assertStudentActiveInTransaction,
} from './student-archive-guard';
import {
  archivedStudentNationalIdError,
  buildStudentOrderBy,
  extractNationalIdSearchDigits,
  normalizePagination,
  notFoundError,
  studentAlreadyArchivedError,
  studentArchivedError,
  studentNationalIdExistsError,
  studentNotArchivedError,
  validateArchiveFilter,
  validateMilitaryStatusFilter,
  validateOptionalAddress,
  validateOptionalBirthDate,
  validateOptionalMilitaryStatus,
  validateOptionalNameFilter,
  validateOptionalNationalIdFilter,
  validateOptionalPhone,
  validateOptionalSearch,
  validatePositiveInt4,
  validateStudentFullName,
  validateStudentNationalId,
  validationError,
  type SortDirection,
  type StudentArchiveFilter,
  type StudentSortField,
} from './students.validation';
import {
  archivedStudentConflictDetails,
  studentView,
  type StudentView,
} from './students.views';

export const STUDENTS_CLOCK = Symbol('STUDENTS_CLOCK');

export interface StudentClock {
  now(): Date;
}

export interface ListStudentsInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly search?: string;
  readonly fullName?: string;
  readonly nationalId?: string;
  readonly militaryStatus?: MilitaryStatus;
  readonly archiveStatus?: StudentArchiveFilter;
  readonly sortBy?: StudentSortField;
  readonly sortOrder?: SortDirection;
}

export interface GetStudentOptions {
  readonly includeArchived?: boolean;
}

export interface CreateStudentInput {
  readonly fullName: string;
  readonly nationalId: string;
  readonly phone?: string | null;
  readonly birthDate?: string | null;
  readonly address?: string | null;
  readonly militaryStatus?: MilitaryStatus | null;
}

export interface UpdateStudentInput {
  readonly expectedVersion: number;
  readonly fullName?: string;
  readonly nationalId?: string;
  readonly phone?: string | null;
  readonly birthDate?: string | null;
  readonly address?: string | null;
  readonly militaryStatus?: MilitaryStatus | null;
}

export interface StudentHistoryQueryInput extends Partial<
  Pick<PageQueryDto, 'page' | 'pageSize'>
> {
  readonly includeArchived?: boolean;
}

@Injectable()
export class StudentsService {
  private readonly transactions: TransactionRunner;
  private readonly clock: StudentClock;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly changeHistory: ChangeHistoryService,
    private readonly archiveGuards: StudentArchiveGuardRegistry,
    @Optional() @Inject(STUDENTS_CLOCK) clock?: StudentClock,
  ) {
    this.transactions = new TransactionRunner(prisma);
    this.clock = clock ?? { now: () => new Date() };
  }

  async listStudents(
    query: ListStudentsInput = {},
  ): Promise<PageResult<StudentView>> {
    const { page, pageSize } = normalizePagination(query);
    const search = validateOptionalSearch(query.search);
    const fullName = validateOptionalNameFilter(query.fullName);
    const nationalId = validateOptionalNationalIdFilter(query.nationalId);
    const militaryStatus = validateMilitaryStatusFilter(query.militaryStatus);
    const archiveStatus = validateArchiveFilter(query.archiveStatus);
    const orderBy = buildStudentOrderBy(query.sortBy, query.sortOrder);

    const conditions: Prisma.StudentWhereInput[] = [];
    if (archiveStatus === 'ACTIVE') {
      conditions.push({ archivedAt: null });
    } else if (archiveStatus === 'ARCHIVED') {
      conditions.push({ archivedAt: { not: null } });
    }

    if (fullName !== undefined) {
      conditions.push({
        fullName: { contains: fullName, mode: 'insensitive' },
      });
    }
    if (nationalId !== undefined) {
      conditions.push({
        nationalId: { startsWith: nationalId },
      });
    }
    if (militaryStatus !== undefined) {
      conditions.push({ militaryStatus });
    }
    if (search !== undefined) {
      const normalizedDigits = extractNationalIdSearchDigits(search);
      if (normalizedDigits !== null) {
        conditions.push({
          OR: [
            { fullName: { contains: search, mode: 'insensitive' } },
            { nationalId: { contains: normalizedDigits } },
          ],
        });
      } else {
        conditions.push({
          fullName: { contains: search, mode: 'insensitive' },
        });
      }
    }

    const where: Prisma.StudentWhereInput =
      conditions.length === 0
        ? {}
        : conditions.length === 1
          ? conditions[0]
          : { AND: conditions };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.student.count({ where }),
      this.prisma.student.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return createPage(rows.map(studentView), total, page, pageSize);
  }

  async getStudent(
    id: number,
    options: GetStudentOptions = {},
  ): Promise<StudentView> {
    const validId = validatePositiveInt4(id, 'id');
    const row = await this.prisma.student.findUnique({
      where: { id: validId },
    });
    if (!row || (!options.includeArchived && row.archivedAt !== null)) {
      throw notFoundError('Student not found');
    }
    return studentView(row);
  }

  async createStudent(
    actor: StaffActor,
    input: CreateStudentInput,
  ): Promise<StudentView> {
    const now = this.clock.now();
    const fullName = validateStudentFullName(input.fullName);
    const nationalId = validateStudentNationalId(input.nationalId);
    const phone = validateOptionalPhone(input.phone) ?? null;
    const birthDate = validateOptionalBirthDate(input.birthDate, now) ?? null;
    const address = validateOptionalAddress(input.address) ?? null;
    const militaryStatus =
      validateOptionalMilitaryStatus(input.militaryStatus) ?? null;

    return this.mapNationalIdUniqueConflict(nationalId, () =>
      this.transactions.run(
        { fullName, nationalId, phone, birthDate, address, militaryStatus },
        async (tx, data) => {
          await this.assertUniqueNationalIdAvailable(tx, data.nationalId);

          const created = await tx.student.create({
            data: {
              fullName: data.fullName,
              nationalId: data.nationalId,
              phone: data.phone,
              birthDate: data.birthDate,
              address: data.address,
              militaryStatus: data.militaryStatus,
              selectedPhotoDocumentId: null,
              archivedAt: null,
            },
          });

          await appendStaffRecordHistory(tx, actor, {
            recordType: 'STUDENT',
            recordId: created.id,
            action: 'CREATED',
            before: null,
            after: studentView(created),
          });
          return studentView(created);
        },
      ),
    );
  }

  async updateStudent(
    actor: StaffActor,
    id: number,
    input: UpdateStudentInput,
  ): Promise<StudentView> {
    const validId = validatePositiveInt4(id, 'id');
    const expectedVersion = validatePositiveInt4(
      input.expectedVersion,
      'expectedVersion',
    );
    if (
      input.fullName === undefined &&
      input.nationalId === undefined &&
      input.phone === undefined &&
      input.birthDate === undefined &&
      input.address === undefined &&
      input.militaryStatus === undefined
    ) {
      throw validationError(
        'body',
        'At least one field to update must be provided',
      );
    }

    const now = this.clock.now();
    const fullName =
      input.fullName !== undefined
        ? validateStudentFullName(input.fullName)
        : undefined;
    const nationalId =
      input.nationalId !== undefined
        ? validateStudentNationalId(input.nationalId)
        : undefined;
    const phone = validateOptionalPhone(input.phone);
    const birthDate = validateOptionalBirthDate(input.birthDate, now);
    const address = validateOptionalAddress(input.address);
    const militaryStatus = validateOptionalMilitaryStatus(input.militaryStatus);

    return this.mapNationalIdUniqueConflict(nationalId, () =>
      this.runVersionedMutation(
        validId,
        expectedVersion,
        { fullName, nationalId, phone, birthDate, address, militaryStatus },
        async (tx, before, data) => {
          if (before.archivedAt !== null) {
            throw studentArchivedError(
              'Archived student must be restored before editing',
            );
          }

          if (
            data.nationalId !== undefined &&
            data.nationalId !== before.nationalId
          ) {
            await this.assertUniqueNationalIdAvailable(tx, data.nationalId);
          }

          const after = await tx.student.update({
            where: { id: before.id },
            data: {
              ...(data.fullName !== undefined
                ? { fullName: data.fullName }
                : {}),
              ...(data.nationalId !== undefined
                ? { nationalId: data.nationalId }
                : {}),
              ...(data.phone !== undefined ? { phone: data.phone } : {}),
              ...(data.birthDate !== undefined
                ? { birthDate: data.birthDate }
                : {}),
              ...(data.address !== undefined ? { address: data.address } : {}),
              ...(data.militaryStatus !== undefined
                ? { militaryStatus: data.militaryStatus }
                : {}),
              version: { increment: 1 },
            },
          });

          await appendStaffRecordHistory(tx, actor, {
            recordType: 'STUDENT',
            recordId: after.id,
            action: 'UPDATED',
            before: studentView(before),
            after: studentView(after),
          });
          return studentView(after);
        },
      ),
    );
  }

  async archiveStudent(
    actor: StaffActor,
    id: number,
    expectedVersion: number,
  ): Promise<StudentView> {
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
          throw studentAlreadyArchivedError();
        }

        await this.archiveGuards.assertCanArchive(tx, before.id);

        const after = await tx.student.update({
          where: { id: before.id },
          data: {
            archivedAt: data.archivedAt,
            version: { increment: 1 },
          },
        });

        await appendStaffRecordHistory(tx, actor, {
          recordType: 'STUDENT',
          recordId: after.id,
          action: 'ARCHIVED',
          before: studentView(before),
          after: studentView(after),
        });
        return studentView(after);
      },
    );
  }

  async restoreStudent(
    actor: StaffActor,
    id: number,
    expectedVersion: number,
  ): Promise<StudentView> {
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
          throw studentNotArchivedError();
        }

        const after = await tx.student.update({
          where: { id: before.id },
          data: {
            archivedAt: null,
            version: { increment: 1 },
          },
        });

        await appendStaffRecordHistory(tx, actor, {
          recordType: 'STUDENT',
          recordId: after.id,
          action: 'RESTORED',
          before: studentView(before),
          after: studentView(after),
        });
        return studentView(after);
      },
    );
  }

  async getStudentHistory(
    id: number,
    query: StudentHistoryQueryInput = {},
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    const validId = validatePositiveInt4(id, 'id');
    const pagination = normalizePagination(query);
    const includeArchived = query.includeArchived ?? false;

    const student = await this.prisma.student.findUnique({
      where: { id: validId },
      select: { id: true, archivedAt: true },
    });
    if (!student || (!includeArchived && student.archivedAt !== null)) {
      throw notFoundError('Student not found');
    }

    return this.changeHistory.listRecordHistory(
      'STUDENT',
      validId,
      pagination,
      () => Promise.resolve(true),
    );
  }

  /** Helper for dependent modules running inside an active serializable transaction. */
  assertActiveStudentInTx(
    tx: Prisma.TransactionClient,
    studentId: number,
  ): Promise<Student> {
    return assertStudentActiveInTransaction(tx, studentId);
  }

  private async assertUniqueNationalIdAvailable(
    tx: Prisma.TransactionClient,
    nationalId: string,
  ): Promise<void> {
    const existing = await tx.student.findUnique({
      where: { nationalId },
    });
    if (existing) {
      throw this.buildNationalIdConflict(existing);
    }
  }

  private async mapNationalIdUniqueConflict<T>(
    nationalId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error) || nationalId === undefined) {
        throw error;
      }
      const existing = await this.prisma.student.findUnique({
        where: { nationalId },
      });
      throw this.buildNationalIdConflict(existing);
    }
  }

  private buildNationalIdConflict(existing: Student | null): ApiError {
    if (existing && existing.archivedAt !== null) {
      return archivedStudentNationalIdError(
        archivedStudentConflictDetails(existing),
      );
    }
    return studentNationalIdExistsError();
  }

  private async runVersionedMutation<Payload, Result>(
    id: number,
    expectedVersion: number,
    payload: Payload,
    execute: (
      tx: Prisma.TransactionClient,
      before: Student,
      payload: NoInfer<Payload>,
    ) => Promise<Result>,
  ): Promise<Result> {
    return this.transactions.run(
      { id, expectedVersion, payload },
      async (tx, original) => {
        const before = await lockStudent(tx, original.id);
        if (!before) {
          throw notFoundError('Student not found');
        }
        if (before.version !== original.expectedVersion) {
          throw new ApiError(
            HttpStatus.CONFLICT,
            ERROR_CODES.STALE_VERSION,
            'Student record has changed; refresh and retry with the current version',
          );
        }
        return execute(tx, before, original.payload);
      },
    );
  }
}

async function lockStudent(
  tx: Prisma.TransactionClient,
  id: number,
): Promise<Student | null> {
  await tx.$queryRaw`SELECT id FROM student WHERE id = ${id} FOR UPDATE`;
  return tx.student.findUnique({ where: { id } });
}
