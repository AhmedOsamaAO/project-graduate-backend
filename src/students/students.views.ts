import { formatCalendarDate } from '../common/dates/office-calendar';
import type { Student } from '../generated/prisma/client';
import type { ArchivedStudentConflictDetails } from './students.validation';

export type StudentViewSource = Pick<
  Student,
  | 'id'
  | 'fullName'
  | 'nationalId'
  | 'phone'
  | 'birthDate'
  | 'address'
  | 'militaryStatus'
  | 'selectedPhotoDocumentId'
  | 'archivedAt'
  | 'version'
  | 'createdAt'
  | 'updatedAt'
>;

export type ArchivedStudentConflictSource = Pick<
  Student,
  'id' | 'fullName' | 'nationalId' | 'archivedAt' | 'version'
>;

/** Explicit allowlist used for both HTTP responses and change-history snapshots. */
export function studentView(row: StudentViewSource) {
  return {
    id: row.id,
    fullName: row.fullName,
    nationalId: row.nationalId,
    phone: row.phone,
    birthDate: row.birthDate ? formatCalendarDate(row.birthDate) : null,
    address: row.address,
    militaryStatus: row.militaryStatus,
    selectedPhotoDocumentId: row.selectedPhotoDocumentId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type StudentView = ReturnType<typeof studentView>;

/** Identifies an existing archived student when a duplicate national ID is submitted by staff. */
export function archivedStudentConflictDetails(
  row: ArchivedStudentConflictSource,
): ArchivedStudentConflictDetails {
  if (!row.archivedAt) {
    throw new Error('Expected archived student to have archivedAt timestamp');
  }
  return {
    studentId: row.id,
    fullName: row.fullName,
    nationalId: row.nationalId,
    archivedAt: row.archivedAt.toISOString(),
    version: row.version,
    requiresRestore: true,
  };
}
