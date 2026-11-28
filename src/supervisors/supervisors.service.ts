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
  AcademicRank,
  DocumentAvailability,
  ExternalApprovalStatus,
  SupervisorAffiliation,
  type Prisma,
  type Supervisor,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionRunner } from '../prisma/transaction-runner';
import { FIXED_OFFICE } from '../reference-data/fixed-office';
import {
  normalizePagination,
  notFoundError,
  validatePositiveInt4,
  validationError,
  type SortDirection,
} from '../students/students.validation';
import {
  SupervisorCorrectionGuardRegistry,
  type SupervisorSnapshot,
} from './supervisor-correction-guard';
import {
  buildSupervisorOrderBy,
  resolveSupervisorAffiliationFields,
  supervisorAlreadyDeactivatedError,
  supervisorApprovalRequiresDocumentError,
  supervisorDepartmentNotInOperatingFacultyError,
  supervisorNotExternalError,
  validateAcademicRank,
  validateExternalApprovalStatus,
  validateOptionalDepartmentId,
  validateOptionalRejectionReason,
  validateOptionalSupervisorEmail,
  validateOptionalSupervisorNameFilter,
  validateOptionalSupervisorNationalId,
  validateOptionalSupervisorNationalIdFilter,
  validateOptionalSupervisorPhone,
  validateOptionalSupervisorSearch,
  validateOptionalWorkplace,
  validateSupervisorActivityFilter,
  validateSupervisorAffiliation,
  validateSupervisorFullName,
  type SupervisorActivityFilter,
  type SupervisorSortField,
} from './supervisors.validation';
import {
  supervisorView,
  toSupervisorSnapshot,
  type SupervisorView,
} from './supervisors.views';

export const SUPERVISORS_CLOCK = Symbol('SUPERVISORS_CLOCK');

export interface SupervisorClock {
  now(): Date;
}

export interface ListSupervisorsInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly search?: string;
  readonly fullName?: string;
  readonly nationalId?: string;
  readonly academicRank?: AcademicRank;
  readonly affiliation?: SupervisorAffiliation;
  readonly departmentId?: number;
  readonly externalApprovalStatus?: ExternalApprovalStatus;
  readonly activityStatus?: SupervisorActivityFilter;
  readonly sortBy?: SupervisorSortField;
  readonly sortOrder?: SortDirection;
}

export interface CreateSupervisorInput {
  readonly fullName: string;
  readonly academicRank: AcademicRank;
  readonly affiliation: SupervisorAffiliation;
  readonly departmentId?: number | null;
  readonly workplace?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly nationalId?: string | null;
}

export interface UpdateSupervisorInput {
  readonly expectedVersion: number;
  readonly fullName?: string;
  readonly academicRank?: AcademicRank;
  readonly affiliation?: SupervisorAffiliation;
  readonly departmentId?: number | null;
  readonly workplace?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly nationalId?: string | null;
}

export interface UpdateSupervisorExternalApprovalInput {
  readonly expectedVersion: number;
  readonly status: ExternalApprovalStatus;
  readonly rejectionReason?: string | null;
}

export type SupervisorHistoryQueryInput = Partial<
  Pick<PageQueryDto, 'page' | 'pageSize'>
>;

@Injectable()
export class SupervisorsService {
  private readonly transactions: TransactionRunner;
  private readonly clock: SupervisorClock;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly changeHistory: ChangeHistoryService,
    private readonly correctionGuards: SupervisorCorrectionGuardRegistry,
    @Optional() @Inject(SUPERVISORS_CLOCK) clock?: SupervisorClock,
  ) {
    this.transactions = new TransactionRunner(prisma);
    this.clock = clock ?? { now: () => new Date() };
  }

  async listSupervisors(
    query: ListSupervisorsInput = {},
  ): Promise<PageResult<SupervisorView>> {
    const { page, pageSize } = normalizePagination(query);
    const search = validateOptionalSupervisorSearch(query.search);
    const fullName = validateOptionalSupervisorNameFilter(query.fullName);
    const nationalId = validateOptionalSupervisorNationalIdFilter(
      query.nationalId,
    );
    const academicRank =
      query.academicRank !== undefined
        ? validateAcademicRank(query.academicRank)
        : undefined;
    const affiliation =
      query.affiliation !== undefined
        ? validateSupervisorAffiliation(query.affiliation)
        : undefined;
    const departmentId =
      query.departmentId !== undefined
        ? validatePositiveInt4(query.departmentId, 'departmentId')
        : undefined;
    const externalApprovalStatus =
      query.externalApprovalStatus !== undefined
        ? validateExternalApprovalStatus(
            query.externalApprovalStatus,
            'externalApprovalStatus',
          )
        : undefined;
    const activityStatus = validateSupervisorActivityFilter(
      query.activityStatus,
    );
    const orderBy = buildSupervisorOrderBy(query.sortBy, query.sortOrder);

    const conditions: Prisma.SupervisorWhereInput[] = [];
    if (activityStatus === 'ACTIVE') {
      conditions.push({ deactivatedAt: null });
    } else if (activityStatus === 'DEACTIVATED') {
      conditions.push({ deactivatedAt: { not: null } });
    }
    if (fullName !== undefined) {
      conditions.push({
        fullName: { contains: fullName, mode: 'insensitive' },
      });
    }
    if (nationalId !== undefined) {
      conditions.push({
        nationalId: { contains: nationalId, mode: 'insensitive' },
      });
    }
    if (academicRank !== undefined) {
      conditions.push({ academicRank });
    }
    if (affiliation !== undefined) {
      conditions.push({ affiliation });
    }
    if (departmentId !== undefined) {
      conditions.push({ departmentId });
    }
    if (externalApprovalStatus !== undefined) {
      conditions.push({ externalApprovalStatus });
    }
    if (search !== undefined) {
      conditions.push({
        OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { nationalId: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.SupervisorWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.supervisor.count({ where }),
      this.prisma.supervisor.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return createPage(rows.map(supervisorView), total, page, pageSize);
  }

  async getSupervisor(id: number): Promise<SupervisorView> {
    const validId = validatePositiveInt4(id, 'id');
    const row = await this.prisma.supervisor.findUnique({
      where: { id: validId },
    });
    if (!row) {
      throw notFoundError('Supervisor not found');
    }
    return supervisorView(row);
  }

  async createSupervisor(
    actor: StaffActor,
    input: CreateSupervisorInput,
  ): Promise<SupervisorView> {
    const fullName = validateSupervisorFullName(input.fullName);
    const academicRank = validateAcademicRank(input.academicRank);
    const affiliation = validateSupervisorAffiliation(input.affiliation);
    const departmentId = validateOptionalDepartmentId(input.departmentId);
    const workplace = validateOptionalWorkplace(input.workplace);
    const phone = validateOptionalSupervisorPhone(input.phone) ?? null;
    const email = validateOptionalSupervisorEmail(input.email) ?? null;
    const nationalId =
      validateOptionalSupervisorNationalId(input.nationalId) ?? null;

    const affiliationFields = resolveSupervisorAffiliationFields(null, {
      affiliation,
      departmentId,
      workplace,
    });

    return this.transactions.run(
      {
        fullName,
        academicRank,
        ...affiliationFields,
        phone,
        email,
        nationalId,
      },
      async (tx, data) => {
        if (data.departmentId !== null) {
          await validateDepartmentForAffiliationInTx(
            tx,
            data.departmentId,
            data.affiliation,
            null,
          );
        }

        const created = await tx.supervisor.create({
          data: {
            fullName: data.fullName,
            academicRank: data.academicRank,
            affiliation: data.affiliation,
            departmentId: data.departmentId,
            workplace: data.workplace,
            phone: data.phone,
            email: data.email,
            nationalId: data.nationalId,
            externalApprovalStatus: data.externalApprovalStatus,
            externalRejectionReason: data.externalRejectionReason,
            deactivatedAt: null,
          },
        });

        await appendStaffRecordHistory(tx, actor, {
          recordType: 'SUPERVISOR',
          recordId: created.id,
          action: 'CREATED',
          before: null,
          after: supervisorView(created),
        });
        return supervisorView(created);
      },
    );
  }

  async updateSupervisor(
    actor: StaffActor,
    id: number,
    input: UpdateSupervisorInput,
  ): Promise<SupervisorView> {
    const validId = validatePositiveInt4(id, 'id');
    const expectedVersion = validatePositiveInt4(
      input.expectedVersion,
      'expectedVersion',
    );
    if (
      input.fullName === undefined &&
      input.academicRank === undefined &&
      input.affiliation === undefined &&
      input.departmentId === undefined &&
      input.workplace === undefined &&
      input.phone === undefined &&
      input.email === undefined &&
      input.nationalId === undefined
    ) {
      throw validationError(
        'body',
        'At least one field to update must be provided',
      );
    }

    const fullName =
      input.fullName !== undefined
        ? validateSupervisorFullName(input.fullName)
        : undefined;
    const academicRank =
      input.academicRank !== undefined
        ? validateAcademicRank(input.academicRank)
        : undefined;
    const affiliation =
      input.affiliation !== undefined
        ? validateSupervisorAffiliation(input.affiliation)
        : undefined;
    const departmentId = validateOptionalDepartmentId(input.departmentId);
    const workplace = validateOptionalWorkplace(input.workplace);
    const phone = validateOptionalSupervisorPhone(input.phone);
    const email = validateOptionalSupervisorEmail(input.email);
    const nationalId = validateOptionalSupervisorNationalId(input.nationalId);

    return this.runVersionedMutation(
      validId,
      expectedVersion,
      {
        fullName,
        academicRank,
        affiliation,
        departmentId,
        workplace,
        phone,
        email,
        nationalId,
      },
      async (tx, before, data) => {
        const affiliationFields = resolveSupervisorAffiliationFields(before, {
          affiliation: data.affiliation,
          departmentId: data.departmentId,
          workplace: data.workplace,
        });

        if (affiliationFields.departmentId !== null) {
          await validateDepartmentForAffiliationInTx(
            tx,
            affiliationFields.departmentId,
            affiliationFields.affiliation,
            data.departmentId ?? null,
          );
        }

        const nextSnapshot: SupervisorSnapshot = {
          id: before.id,
          fullName: data.fullName ?? before.fullName,
          academicRank: data.academicRank ?? before.academicRank,
          affiliation: affiliationFields.affiliation,
          departmentId: affiliationFields.departmentId,
          workplace: affiliationFields.workplace,
          phone: data.phone !== undefined ? data.phone : before.phone,
          email: data.email !== undefined ? data.email : before.email,
          nationalId:
            data.nationalId !== undefined ? data.nationalId : before.nationalId,
          externalApprovalStatus: affiliationFields.externalApprovalStatus,
          externalRejectionReason: affiliationFields.externalRejectionReason,
          deactivatedAt: before.deactivatedAt,
          version: before.version + 1,
        };

        await this.correctionGuards.assertCanCorrect(tx, {
          supervisorId: before.id,
          before: toSupervisorSnapshot(before),
          next: nextSnapshot,
        });

        const after = await tx.supervisor.update({
          where: { id: before.id },
          data: {
            fullName: nextSnapshot.fullName,
            academicRank: nextSnapshot.academicRank,
            affiliation: nextSnapshot.affiliation,
            departmentId: nextSnapshot.departmentId,
            workplace: nextSnapshot.workplace,
            phone: nextSnapshot.phone,
            email: nextSnapshot.email,
            nationalId: nextSnapshot.nationalId,
            externalApprovalStatus: nextSnapshot.externalApprovalStatus,
            externalRejectionReason: nextSnapshot.externalRejectionReason,
            version: { increment: 1 },
          },
        });

        await appendStaffRecordHistory(tx, actor, {
          recordType: 'SUPERVISOR',
          recordId: after.id,
          action: 'UPDATED',
          before: supervisorView(before),
          after: supervisorView(after),
        });
        return supervisorView(after);
      },
      departmentId,
    );
  }

  async updateExternalApproval(
    actor: StaffActor,
    id: number,
    input: UpdateSupervisorExternalApprovalInput,
  ): Promise<SupervisorView> {
    const validId = validatePositiveInt4(id, 'id');
    const expectedVersion = validatePositiveInt4(
      input.expectedVersion,
      'expectedVersion',
    );
    const status = validateExternalApprovalStatus(input.status, 'status');
    const rejectionReason = validateOptionalRejectionReason(
      input.rejectionReason,
    );
    if (
      status !== ExternalApprovalStatus.REJECTED &&
      rejectionReason !== undefined &&
      rejectionReason !== null
    ) {
      throw validationError(
        'rejectionReason',
        'rejectionReason is only allowed when status is REJECTED',
      );
    }

    return this.runVersionedMutation(
      validId,
      expectedVersion,
      { status, rejectionReason },
      async (tx, before, data) => {
        if (before.affiliation !== SupervisorAffiliation.EXTERNAL) {
          throw supervisorNotExternalError();
        }

        if (data.status === ExternalApprovalStatus.APPROVED) {
          const supportingDoc = await tx.document.findFirst({
            where: {
              supervisorId: before.id,
              archivedAt: null,
              availability: DocumentAvailability.AVAILABLE,
            },
            select: { id: true },
          });
          if (!supportingDoc) {
            throw supervisorApprovalRequiresDocumentError();
          }
        }

        const after = await tx.supervisor.update({
          where: { id: before.id },
          data: {
            externalApprovalStatus: data.status,
            externalRejectionReason:
              data.status === ExternalApprovalStatus.REJECTED
                ? (data.rejectionReason ?? null)
                : null,
            version: { increment: 1 },
          },
        });

        await appendStaffRecordHistory(tx, actor, {
          recordType: 'SUPERVISOR',
          recordId: after.id,
          action: 'UPDATED',
          before: supervisorView(before),
          after: supervisorView(after),
        });
        return supervisorView(after);
      },
    );
  }

  async deactivateSupervisor(
    actor: StaffActor,
    id: number,
    expectedVersion: number,
  ): Promise<SupervisorView> {
    const validId = validatePositiveInt4(id, 'id');
    const validVersion = validatePositiveInt4(
      expectedVersion,
      'expectedVersion',
    );
    const deactivatedAt = this.clock.now();

    return this.runVersionedMutation(
      validId,
      validVersion,
      { deactivatedAt },
      async (tx, before, data) => {
        if (before.deactivatedAt !== null) {
          throw supervisorAlreadyDeactivatedError();
        }

        const after = await tx.supervisor.update({
          where: { id: before.id },
          data: {
            deactivatedAt: data.deactivatedAt,
            version: { increment: 1 },
          },
        });

        await appendStaffRecordHistory(tx, actor, {
          recordType: 'SUPERVISOR',
          recordId: after.id,
          action: 'DEACTIVATED',
          before: supervisorView(before),
          after: supervisorView(after),
        });
        return supervisorView(after);
      },
    );
  }

  getSupervisorHistory(
    id: number,
    query: SupervisorHistoryQueryInput = {},
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    const validId = validatePositiveInt4(id, 'id');
    const pagination = normalizePagination(query);

    return this.changeHistory.listRecordHistory(
      'SUPERVISOR',
      validId,
      pagination,
      async (recordId) => {
        const row = await this.prisma.supervisor.findUnique({
          where: { id: recordId },
          select: { id: true },
        });
        return row !== null;
      },
    );
  }

  private async runVersionedMutation<Payload, Result>(
    id: number,
    expectedVersion: number,
    payload: Payload,
    execute: (
      tx: Prisma.TransactionClient,
      before: Supervisor,
      payload: NoInfer<Payload>,
    ) => Promise<Result>,
    preLockDepartmentId?: number | null,
  ): Promise<Result> {
    return this.transactions.run(
      { id, expectedVersion, payload, preLockDepartmentId },
      async (tx, original) => {
        if (
          original.preLockDepartmentId !== undefined &&
          original.preLockDepartmentId !== null
        ) {
          await tx.$queryRaw`SELECT id FROM department WHERE id = ${original.preLockDepartmentId} FOR SHARE`;
        }

        const before = await lockSupervisor(tx, original.id);
        if (!before) {
          throw notFoundError('Supervisor not found');
        }
        if (before.version !== original.expectedVersion) {
          throw new ApiError(
            HttpStatus.CONFLICT,
            ERROR_CODES.STALE_VERSION,
            'Supervisor record has changed; refresh and retry with the current version',
          );
        }
        return execute(tx, before, original.payload);
      },
    );
  }
}

async function lockSupervisor(
  tx: Prisma.TransactionClient,
  id: number,
): Promise<Supervisor | null> {
  await tx.$queryRaw`SELECT id FROM supervisor WHERE id = ${id} FOR UPDATE`;
  return tx.supervisor.findUnique({ where: { id } });
}

async function validateDepartmentForAffiliationInTx(
  tx: Prisma.TransactionClient,
  departmentId: number,
  affiliation: SupervisorAffiliation,
  preLockedDepartmentId: number | null,
): Promise<void> {
  if (departmentId !== preLockedDepartmentId) {
    await tx.$queryRaw`SELECT id FROM department WHERE id = ${departmentId} FOR SHARE`;
  }
  const department = await tx.department.findUnique({
    where: { id: departmentId },
    select: { id: true, facultyId: true },
  });
  if (!department) {
    throw notFoundError('Department not found');
  }
  if (
    affiliation === SupervisorAffiliation.INTERNAL &&
    department.facultyId !== FIXED_OFFICE.faculty.id
  ) {
    throw supervisorDepartmentNotInOperatingFacultyError();
  }
}
