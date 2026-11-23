import type {
  Department,
  EducationalInstitution,
  Faculty,
} from '../generated/prisma/client';

export type InstitutionViewSource = Pick<
  EducationalInstitution,
  'id' | 'name' | 'institutionType' | 'version' | 'createdAt' | 'updatedAt'
>;

export type FacultyViewSource = Pick<
  Faculty,
  'id' | 'institutionId' | 'name' | 'version' | 'createdAt' | 'updatedAt'
>;

export type DepartmentViewSource = Pick<
  Department,
  'id' | 'facultyId' | 'name' | 'version' | 'createdAt' | 'updatedAt'
>;

/** Explicit allowlist used for both HTTP responses and change-history snapshots. */
export function institutionView(row: InstitutionViewSource) {
  return {
    id: row.id,
    name: row.name,
    institutionType: row.institutionType,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type EducationalInstitutionView = ReturnType<typeof institutionView>;

/** Explicit allowlist used for both HTTP responses and change-history snapshots. */
export function facultyView(row: FacultyViewSource) {
  return {
    id: row.id,
    institutionId: row.institutionId,
    name: row.name,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type FacultyView = ReturnType<typeof facultyView>;

/** Explicit allowlist used for both HTTP responses and change-history snapshots. */
export function departmentView(row: DepartmentViewSource) {
  return {
    id: row.id,
    facultyId: row.facultyId,
    name: row.name,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type DepartmentView = ReturnType<typeof departmentView>;
