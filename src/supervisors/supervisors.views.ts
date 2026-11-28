import type { Supervisor } from '../generated/prisma/client';
import type { SupervisorSnapshot } from './supervisor-correction-guard';

export type SupervisorViewSource = Pick<
  Supervisor,
  | 'id'
  | 'fullName'
  | 'academicRank'
  | 'affiliation'
  | 'departmentId'
  | 'workplace'
  | 'phone'
  | 'email'
  | 'nationalId'
  | 'externalApprovalStatus'
  | 'externalRejectionReason'
  | 'deactivatedAt'
  | 'version'
  | 'createdAt'
  | 'updatedAt'
>;

/** Explicit allowlist used for API responses and protected change history. */
export function supervisorView(row: SupervisorViewSource) {
  return {
    id: row.id,
    fullName: row.fullName,
    academicRank: row.academicRank,
    affiliation: row.affiliation,
    departmentId: row.departmentId,
    workplace: row.workplace,
    phone: row.phone,
    email: row.email,
    nationalId: row.nationalId,
    externalApprovalStatus: row.externalApprovalStatus,
    externalRejectionReason: row.externalRejectionReason,
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type SupervisorView = ReturnType<typeof supervisorView>;

export function toSupervisorSnapshot(row: Supervisor): SupervisorSnapshot {
  return {
    id: row.id,
    fullName: row.fullName,
    academicRank: row.academicRank,
    affiliation: row.affiliation,
    departmentId: row.departmentId,
    workplace: row.workplace,
    phone: row.phone,
    email: row.email,
    nationalId: row.nationalId,
    externalApprovalStatus: row.externalApprovalStatus,
    externalRejectionReason: row.externalRejectionReason,
    deactivatedAt: row.deactivatedAt,
    version: row.version,
  };
}
