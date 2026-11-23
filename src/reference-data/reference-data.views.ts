import type {
  Department,
  EducationalInstitution,
  Faculty,
} from '../generated/prisma/client';
import { isFixedFacultyId, isFixedInstitutionId } from './fixed-office';

export type InstitutionSnapshotSource = Pick<
  EducationalInstitution,
  'id' | 'name' | 'institutionType' | 'version' | 'createdAt' | 'updatedAt'
>;

export type FacultySnapshotSource = Pick<
  Faculty,
  'id' | 'institutionId' | 'name' | 'version' | 'createdAt' | 'updatedAt'
>;

export type DepartmentSnapshotSource = Pick<
  Department,
  'id' | 'facultyId' | 'name' | 'version' | 'createdAt' | 'updatedAt'
>;

export function institutionSnapshot(row: InstitutionSnapshotSource) {
  return {
    id: row.id,
    name: row.name,
    institutionType: row.institutionType,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type InstitutionSnapshot = ReturnType<typeof institutionSnapshot>;

export function institutionView(row: InstitutionSnapshotSource) {
  return {
    ...institutionSnapshot(row),
    isFixedOffice: isFixedInstitutionId(row.id),
  };
}

export type EducationalInstitutionView = ReturnType<typeof institutionView>;

export function facultySnapshot(row: FacultySnapshotSource) {
  return {
    id: row.id,
    institutionId: row.institutionId,
    name: row.name,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type FacultySnapshot = ReturnType<typeof facultySnapshot>;

export function facultyView(row: FacultySnapshotSource) {
  return {
    ...facultySnapshot(row),
    isFixedOffice: isFixedFacultyId(row.id),
  };
}

export type FacultyView = ReturnType<typeof facultyView>;

export function departmentSnapshot(row: DepartmentSnapshotSource) {
  return {
    id: row.id,
    facultyId: row.facultyId,
    name: row.name,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type DepartmentView = ReturnType<typeof departmentSnapshot>;

export function departmentView(row: DepartmentSnapshotSource): DepartmentView {
  return departmentSnapshot(row);
}
