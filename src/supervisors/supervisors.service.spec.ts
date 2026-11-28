import { HttpStatus } from '@nestjs/common';
import { ChangeHistoryService } from '../change-history/change-history.service';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  AcademicRank,
  DocumentAvailability,
  DocumentType,
  ExternalApprovalStatus,
  Prisma,
  SupervisorAffiliation,
  type Department,
  type Document,
  type Supervisor,
} from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { FIXED_OFFICE } from '../reference-data/fixed-office';
import { SupervisorCorrectionGuardRegistry } from './supervisor-correction-guard';
import { SupervisorsService } from './supervisors.service';

function createFakeSupervisorsPrisma() {
  const now = new Date('2026-11-28T10:00:00.000Z');
  let tick = 0;
  const nextTime = () => new Date(now.getTime() + ++tick * 1000);

  let state = {
    departments: [
      {
        id: 1,
        facultyId: FIXED_OFFICE.faculty.id,
        name: 'Computer Science',
        version: 1,
        createdAt: now,
        updatedAt: now,
      } satisfies Department,
      {
        id: 2,
        facultyId: FIXED_OFFICE.faculty.id,
        name: 'Information Systems',
        version: 1,
        createdAt: now,
        updatedAt: now,
      } satisfies Department,
      {
        id: 50,
        facultyId: 9,
        name: 'External Engineering Dept',
        version: 1,
        createdAt: now,
        updatedAt: now,
      } satisfies Department,
    ],
    supervisors: [] as Supervisor[],
    documents: [] as Document[],
    history: [] as Array<{
      id: number;
      recordType: string;
      recordId: number | null;
      action: string;
      actorKind: string;
      staffUserId: number | null;
      operatorAttribution: string | null;
      occurredAt: Date;
      before: unknown;
      after: unknown;
    }>,
    nextSupervisorId: 1,
    nextDocId: 1,
    nextHistoryId: 1,
  };

  const staffUsers = new Map([
    [10, { id: 10, username: 'staff.one', fullName: 'Staff One' }],
  ]);

  const filterSupervisors = (
    rows: Supervisor[],
    where: Prisma.SupervisorWhereInput = {},
  ) => {
    const clauses: Prisma.SupervisorWhereInput[] = Array.isArray(where.AND)
      ? where.AND
      : [where];

    return rows.filter((row) =>
      clauses.every((clause) => {
        if (clause.deactivatedAt === null && row.deactivatedAt !== null) {
          return false;
        }
        if (
          typeof clause.deactivatedAt === 'object' &&
          clause.deactivatedAt !== null &&
          'not' in clause.deactivatedAt &&
          row.deactivatedAt === null
        ) {
          return false;
        }
        if (
          clause.academicRank !== undefined &&
          row.academicRank !== clause.academicRank
        ) {
          return false;
        }
        if (
          clause.affiliation !== undefined &&
          row.affiliation !== clause.affiliation
        ) {
          return false;
        }
        if (
          clause.departmentId !== undefined &&
          row.departmentId !== clause.departmentId
        ) {
          return false;
        }
        if (
          clause.externalApprovalStatus !== undefined &&
          row.externalApprovalStatus !== clause.externalApprovalStatus
        ) {
          return false;
        }
        if (
          clause.fullName &&
          typeof clause.fullName === 'object' &&
          'contains' in clause.fullName &&
          typeof clause.fullName.contains === 'string'
        ) {
          if (
            !row.fullName
              .toLowerCase()
              .includes(clause.fullName.contains.toLowerCase())
          ) {
            return false;
          }
        }
        if (
          clause.nationalId &&
          typeof clause.nationalId === 'object' &&
          'contains' in clause.nationalId &&
          typeof clause.nationalId.contains === 'string'
        ) {
          if (
            !row.nationalId
              ?.toLowerCase()
              .includes(clause.nationalId.contains.toLowerCase())
          ) {
            return false;
          }
        }
        if (Array.isArray(clause.OR)) {
          const matchedOr = clause.OR.some((branch) => {
            if (
              branch.fullName &&
              typeof branch.fullName === 'object' &&
              'contains' in branch.fullName &&
              typeof branch.fullName.contains === 'string'
            ) {
              return row.fullName
                .toLowerCase()
                .includes(branch.fullName.contains.toLowerCase());
            }
            if (
              branch.nationalId &&
              typeof branch.nationalId === 'object' &&
              'contains' in branch.nationalId &&
              typeof branch.nationalId.contains === 'string'
            ) {
              return (
                row.nationalId
                  ?.toLowerCase()
                  .includes(branch.nationalId.contains.toLowerCase()) ?? false
              );
            }
            return false;
          });
          if (!matchedOr) {
            return false;
          }
        }
        return true;
      }),
    );
  };

  const makeClient = (getWorking: () => typeof state) => ({
    $queryRaw: () => Promise.resolve([]),
    department: {
      findUnique: ({ where }: { where: { id: number } }) => {
        const found = getWorking().departments.find((d) => d.id === where.id);
        return Promise.resolve(found ? structuredClone(found) : null);
      },
    },
    document: {
      findFirst: ({
        where,
      }: {
        where: {
          supervisorId?: number;
          archivedAt?: null;
          availability?: DocumentAvailability;
        };
      }) => {
        const found = getWorking().documents.find(
          (doc) =>
            (where.supervisorId === undefined ||
              doc.supervisorId === where.supervisorId) &&
            (where.archivedAt === undefined || doc.archivedAt === null) &&
            (where.availability === undefined ||
              doc.availability === where.availability),
        );
        return Promise.resolve(found ? structuredClone(found) : null);
      },
    },
    supervisor: {
      count: ({ where = {} }: { where?: Prisma.SupervisorWhereInput } = {}) =>
        Promise.resolve(
          filterSupervisors(getWorking().supervisors, where).length,
        ),
      findMany: ({
        where = {},
        skip = 0,
        take = 20,
      }: {
        where?: Prisma.SupervisorWhereInput;
        skip?: number;
        take?: number;
      }) => {
        const filtered = filterSupervisors(getWorking().supervisors, where);
        return Promise.resolve(
          filtered
            .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.id - b.id)
            .slice(skip, skip + take)
            .map((s) => structuredClone(s)),
        );
      },
      findUnique: ({ where }: { where: { id: number } }) => {
        const found = getWorking().supervisors.find((s) => s.id === where.id);
        return Promise.resolve(found ? structuredClone(found) : null);
      },
      create: ({ data }: { data: Record<string, unknown> }) => {
        const working = getWorking();
        const t = nextTime();
        const created: Supervisor = {
          id: working.nextSupervisorId++,
          fullName: data.fullName as string,
          academicRank: data.academicRank as AcademicRank,
          affiliation: data.affiliation as SupervisorAffiliation,
          departmentId: (data.departmentId as number | null) ?? null,
          workplace: (data.workplace as string | null) ?? null,
          phone: (data.phone as string | null) ?? null,
          email: (data.email as string | null) ?? null,
          nationalId: (data.nationalId as string | null) ?? null,
          externalApprovalStatus:
            (data.externalApprovalStatus as ExternalApprovalStatus | null) ??
            null,
          externalRejectionReason:
            (data.externalRejectionReason as string | null) ?? null,
          deactivatedAt: (data.deactivatedAt as Date | null) ?? null,
          version: 1,
          createdAt: t,
          updatedAt: t,
        };
        working.supervisors.push(created);
        return Promise.resolve(structuredClone(created));
      },
      update: ({
        where,
        data,
      }: {
        where: { id: number };
        data: Record<string, unknown> & { version?: { increment: number } };
      }) => {
        const working = getWorking();
        const idx = working.supervisors.findIndex((s) => s.id === where.id);
        if (idx === -1) return Promise.reject(new Error('Missing supervisor'));
        const current = working.supervisors[idx];
        const updated: Supervisor = {
          ...current,
          fullName: (data.fullName as string | undefined) ?? current.fullName,
          academicRank:
            (data.academicRank as AcademicRank | undefined) ??
            current.academicRank,
          affiliation:
            (data.affiliation as SupervisorAffiliation | undefined) ??
            current.affiliation,
          departmentId:
            data.departmentId !== undefined
              ? (data.departmentId as number | null)
              : current.departmentId,
          workplace:
            data.workplace !== undefined
              ? (data.workplace as string | null)
              : current.workplace,
          phone:
            data.phone !== undefined
              ? (data.phone as string | null)
              : current.phone,
          email:
            data.email !== undefined
              ? (data.email as string | null)
              : current.email,
          nationalId:
            data.nationalId !== undefined
              ? (data.nationalId as string | null)
              : current.nationalId,
          externalApprovalStatus:
            data.externalApprovalStatus !== undefined
              ? (data.externalApprovalStatus as ExternalApprovalStatus | null)
              : current.externalApprovalStatus,
          externalRejectionReason:
            data.externalRejectionReason !== undefined
              ? (data.externalRejectionReason as string | null)
              : current.externalRejectionReason,
          deactivatedAt:
            data.deactivatedAt !== undefined
              ? (data.deactivatedAt as Date | null)
              : current.deactivatedAt,
          version: current.version + (data.version?.increment ?? 0),
          updatedAt: nextTime(),
        };
        working.supervisors[idx] = updated;
        return Promise.resolve(structuredClone(updated));
      },
    },
    changeHistory: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        const working = getWorking();
        working.history.push({
          id: working.nextHistoryId++,
          recordType: data.recordType as string,
          recordId: (data.recordId as number | null) ?? null,
          action: data.action as string,
          actorKind: data.actorKind as string,
          staffUserId: (data.staffUserId as number | null) ?? null,
          operatorAttribution:
            (data.operatorAttribution as string | null) ?? null,
          occurredAt: nextTime(),
          before: data.before,
          after: data.after,
        });
        return Promise.resolve({});
      },
      count: ({ where }: { where: { recordType: string; recordId: number } }) =>
        Promise.resolve(
          getWorking().history.filter(
            (h) =>
              h.recordType === where.recordType &&
              h.recordId === where.recordId,
          ).length,
        ),
      findMany: ({
        where,
        skip = 0,
        take = 20,
      }: {
        where: { recordType: string; recordId: number };
        skip?: number;
        take?: number;
      }) =>
        Promise.resolve(
          getWorking()
            .history.filter(
              (h) =>
                h.recordType === where.recordType &&
                h.recordId === where.recordId,
            )
            .sort(
              (a, b) =>
                b.occurredAt.getTime() - a.occurredAt.getTime() || b.id - a.id,
            )
            .slice(skip, skip + take)
            .map((h) => ({
              ...structuredClone(h),
              staffUser: h.staffUserId
                ? (staffUsers.get(h.staffUserId) ?? null)
                : null,
            })),
        ),
    },
  });

  const root = makeClient(() => state);
  const prisma = {
    ...root,
    $transaction: async <T>(
      arg:
        | Array<Promise<unknown>>
        | ((tx: Prisma.TransactionClient) => Promise<T>),
    ) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      const draft = structuredClone(state);
      const tx = makeClient(() => draft) as unknown as Prisma.TransactionClient;
      const result = await arg(tx);
      state = draft;
      return result;
    },
  } as unknown as PrismaService;

  return {
    prisma,
    getState: () => state,
    addSupportingDocument: (
      supervisorId: number,
      archivedAt: Date | null = null,
    ): Document => {
      const t = nextTime();
      const doc: Document = {
        id: state.nextDocId++,
        studentId: null,
        supervisorId,
        qualificationId: null,
        documentType: DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT,
        description: null,
        originalFileName: 'cv.pdf',
        storageKey: String(state.nextDocId).padStart(64, '0'),
        mimeType: 'application/pdf',
        byteSize: 1024,
        uploadedAt: t,
        archivedAt,
        availability: DocumentAvailability.AVAILABLE,
        deletedAt: null,
        deletedByStaffUserId: null,
        version: 1,
        createdAt: t,
        updatedAt: t,
      };
      state.documents.push(doc);
      return doc;
    },
  };
}

describe('SupervisorsService', () => {
  const actor = { staffUserId: 10 };
  const fixedNow = new Date('2026-11-28T15:00:00.000Z');

  let fakeDb: ReturnType<typeof createFakeSupervisorsPrisma>;
  let correctionGuards: SupervisorCorrectionGuardRegistry;
  let service: SupervisorsService;

  beforeEach(() => {
    fakeDb = createFakeSupervisorsPrisma();
    correctionGuards = new SupervisorCorrectionGuardRegistry();
    const history = new ChangeHistoryService(fakeDb.prisma);
    service = new SupervisorsService(fakeDb.prisma, history, correctionGuards, {
      now: () => fixedNow,
    });
  });

  it('creates internal and external supervisors, enforces operating-faculty departments, and supports name/nationalId search', async () => {
    await expect(
      service.createSupervisor(actor, {
        fullName: 'Dr. Wrong Dept',
        academicRank: AcademicRank.LECTURER,
        affiliation: SupervisorAffiliation.INTERNAL,
        departmentId: 50,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SUPERVISOR_DEPARTMENT_NOT_IN_OPERATING_FACULTY,
    });

    const internal = await service.createSupervisor(actor, {
      fullName: 'Dr. Adel Ibrahim',
      academicRank: AcademicRank.PROFESSOR,
      affiliation: SupervisorAffiliation.INTERNAL,
      departmentId: 1,
      nationalId: '00441122',
      email: 'adel@fci.zu.edu.eg',
    });
    expect(internal).toMatchObject({
      affiliation: SupervisorAffiliation.INTERNAL,
      departmentId: 1,
      workplace: null,
      externalApprovalStatus: null,
      nationalId: '00441122',
      deactivatedAt: null,
      version: 1,
    });

    const external = await service.createSupervisor(actor, {
      fullName: 'Dr. Salma Nabil',
      academicRank: AcademicRank.ASSOCIATE_LECTURER,
      affiliation: SupervisorAffiliation.EXTERNAL,
      workplace: 'Cairo University',
      departmentId: 50,
      nationalId: 'PASSPORT-009',
    });
    expect(external).toMatchObject({
      affiliation: SupervisorAffiliation.EXTERNAL,
      departmentId: 50,
      workplace: 'Cairo University',
      externalApprovalStatus: ExternalApprovalStatus.PENDING,
      externalRejectionReason: null,
    });

    const byLeadingZeroId = await service.listSupervisors({
      nationalId: '0044',
    });
    expect(byLeadingZeroId.items.map((item) => item.id)).toEqual([internal.id]);

    const bySearch = await service.listSupervisors({ search: 'passport' });
    expect(bySearch.items.map((item) => item.id)).toEqual([external.id]);
  });

  it('enforces external approval document evidence, rejection reasons, and stale versions', async () => {
    const internal = await service.createSupervisor(actor, {
      fullName: 'Dr. Internal',
      academicRank: AcademicRank.LECTURER,
      affiliation: SupervisorAffiliation.INTERNAL,
      departmentId: 1,
    });
    await expect(
      service.updateExternalApproval(actor, internal.id, {
        expectedVersion: 1,
        status: ExternalApprovalStatus.APPROVED,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SUPERVISOR_NOT_EXTERNAL });

    const external = await service.createSupervisor(actor, {
      fullName: 'Dr. External',
      academicRank: AcademicRank.LECTURER,
      affiliation: SupervisorAffiliation.EXTERNAL,
      workplace: 'Ain Shams University',
    });

    await expect(
      service.updateExternalApproval(actor, external.id, {
        expectedVersion: 1,
        status: ExternalApprovalStatus.APPROVED,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SUPERVISOR_APPROVAL_REQUIRES_DOCUMENT,
    });

    // Archived document alone does not satisfy approval
    fakeDb.addSupportingDocument(external.id, new Date());
    await expect(
      service.updateExternalApproval(actor, external.id, {
        expectedVersion: 1,
        status: ExternalApprovalStatus.APPROVED,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SUPERVISOR_APPROVAL_REQUIRES_DOCUMENT,
    });

    const rejected = await service.updateExternalApproval(actor, external.id, {
      expectedVersion: 1,
      status: ExternalApprovalStatus.REJECTED,
      rejectionReason: 'Expired letter',
    });
    expect(rejected).toMatchObject({
      externalApprovalStatus: ExternalApprovalStatus.REJECTED,
      externalRejectionReason: 'Expired letter',
      version: 2,
    });

    // Non-REJECTED status rejects rejectionReason
    await expect(
      service.updateExternalApproval(actor, external.id, {
        expectedVersion: 2,
        status: ExternalApprovalStatus.PENDING,
        rejectionReason: 'Should fail',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    fakeDb.addSupportingDocument(external.id, null);
    const approved = await service.updateExternalApproval(actor, external.id, {
      expectedVersion: 2,
      status: ExternalApprovalStatus.APPROVED,
    });
    expect(approved).toMatchObject({
      externalApprovalStatus: ExternalApprovalStatus.APPROVED,
      externalRejectionReason: null,
      version: 3,
    });

    // Stale version fails
    await expect(
      service.updateExternalApproval(actor, external.id, {
        expectedVersion: 2,
        status: ExternalApprovalStatus.PENDING,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STALE_VERSION });
  });

  it('invokes correction guard seam on updates, rolls back rejections, and skips guard on deactivation', async () => {
    const sup = await service.createSupervisor(actor, {
      fullName: 'Dr. Main',
      academicRank: AcademicRank.PROFESSOR,
      affiliation: SupervisorAffiliation.INTERNAL,
      departmentId: 1,
    });

    const guardCalls: Array<{ fromRank: AcademicRank; toRank: AcademicRank }> =
      [];
    correctionGuards.register({
      name: 'mock-appointment-guard',
      assertCanCorrect: (_tx, ctx) => {
        guardCalls.push({
          fromRank: ctx.before.academicRank,
          toRank: ctx.next.academicRank,
        });
        if (ctx.next.academicRank !== AcademicRank.PROFESSOR) {
          return Promise.reject(
            new ApiError(
              HttpStatus.CONFLICT,
              ERROR_CODES.SUPERVISOR_CORRECTION_CONFLICT,
              'Cannot downgrade rank while main supervisor',
            ),
          );
        }
        return Promise.resolve();
      },
    });

    await expect(
      service.updateSupervisor(actor, sup.id, {
        expectedVersion: 1,
        academicRank: AcademicRank.LECTURER,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SUPERVISOR_CORRECTION_CONFLICT,
    });

    expect(guardCalls).toHaveLength(1);
    expect(fakeDb.getState().supervisors[0].version).toBe(1);
    expect(fakeDb.getState().history).toHaveLength(1);

    // Deactivation does not trigger correction guard and rejects double deactivation
    const deactivated = await service.deactivateSupervisor(actor, sup.id, 1);
    expect(deactivated).toMatchObject({
      deactivatedAt: fixedNow.toISOString(),
      version: 2,
    });
    expect(guardCalls).toHaveLength(1);

    await expect(
      service.deactivateSupervisor(actor, sup.id, 2),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SUPERVISOR_ALREADY_DEACTIVATED,
    });

    const history = await service.getSupervisorHistory(sup.id);
    expect(history.items.map((h) => h.action)).toEqual([
      'DEACTIVATED',
      'CREATED',
    ]);
  });
});
