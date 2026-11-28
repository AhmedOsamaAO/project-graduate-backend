import { formatCalendarDate } from '../common/dates/office-calendar';
import type { StudentQualification } from '../generated/prisma/client';
import type { QualificationSnapshot } from './qualification-mutation-guard';

export type QualificationViewSource = Pick<
  StudentQualification,
  | 'id'
  | 'studentId'
  | 'degreeLevel'
  | 'qualificationName'
  | 'institutionId'
  | 'facultyId'
  | 'departmentId'
  | 'graduationYear'
  | 'overallGrade'
  | 'equivalencyStatus'
  | 'equivalencyDecisionNumber'
  | 'equivalencyDecisionDate'
  | 'archivedAt'
  | 'version'
  | 'createdAt'
  | 'updatedAt'
>;

/** Explicit allowlist used for both HTTP responses and change-history snapshots. */
export function qualificationView(row: QualificationViewSource) {
  return {
    id: row.id,
    studentId: row.studentId,
    degreeLevel: row.degreeLevel,
    qualificationName: row.qualificationName,
    institutionId: row.institutionId,
    facultyId: row.facultyId,
    departmentId: row.departmentId,
    graduationYear: row.graduationYear,
    overallGrade: row.overallGrade,
    equivalencyStatus: row.equivalencyStatus,
    equivalencyDecisionNumber: row.equivalencyDecisionNumber,
    equivalencyDecisionDate: row.equivalencyDecisionDate
      ? formatCalendarDate(row.equivalencyDecisionDate)
      : null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type QualificationView = ReturnType<typeof qualificationView>;

/** Explicit immutable snapshot passed to transaction-scoped mutation guards. */
export function toQualificationSnapshot(
  row: QualificationSnapshot,
): QualificationSnapshot {
  return {
    id: row.id,
    studentId: row.studentId,
    degreeLevel: row.degreeLevel,
    qualificationName: row.qualificationName,
    institutionId: row.institutionId,
    facultyId: row.facultyId,
    departmentId: row.departmentId,
    graduationYear: row.graduationYear,
    overallGrade: row.overallGrade,
    equivalencyStatus: row.equivalencyStatus,
    equivalencyDecisionNumber: row.equivalencyDecisionNumber,
    equivalencyDecisionDate: row.equivalencyDecisionDate,
    archivedAt: row.archivedAt,
    version: row.version,
  };
}
