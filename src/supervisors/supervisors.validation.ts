import { HttpStatus } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  AcademicRank,
  ExternalApprovalStatus,
  SupervisorAffiliation,
  type Prisma,
} from '../generated/prisma/client';
import {
  hasControlCharacters,
  validateOptionalNullableText,
  validateOptionalQueryText,
  validatePositiveInt4,
  validateTrimmedPrintableText,
  validationError,
  type SortDirection,
} from '../students/students.validation';

export const SUPERVISOR_ACTIVITY_FILTERS = [
  'ACTIVE',
  'DEACTIVATED',
  'ALL',
] as const;
export type SupervisorActivityFilter =
  (typeof SUPERVISOR_ACTIVITY_FILTERS)[number];

export const SUPERVISOR_SORT_FIELDS = [
  'fullName',
  'nationalId',
  'academicRank',
  'affiliation',
  'createdAt',
  'id',
] as const;
export type SupervisorSortField = (typeof SUPERVISOR_SORT_FIELDS)[number];

const VALID_ACADEMIC_RANKS = new Set<string>(Object.values(AcademicRank));
const VALID_AFFILIATIONS = new Set<string>(
  Object.values(SupervisorAffiliation),
);
const VALID_APPROVAL_STATUSES = new Set<string>(
  Object.values(ExternalApprovalStatus),
);
const VALID_ACTIVITY_FILTERS = new Set<string>(SUPERVISOR_ACTIVITY_FILTERS);

export function validateSupervisorFullName(value: string): string {
  return validateTrimmedPrintableText(value, 'fullName', 200);
}

export function validateAcademicRank(value: AcademicRank): AcademicRank {
  if (typeof value !== 'string' || !VALID_ACADEMIC_RANKS.has(value)) {
    throw validationError(
      'academicRank',
      'academicRank must be PROFESSOR, ASSOCIATE_PROFESSOR, LECTURER, or ASSOCIATE_LECTURER',
    );
  }
  return value;
}

export function validateSupervisorAffiliation(
  value: SupervisorAffiliation,
): SupervisorAffiliation {
  if (typeof value !== 'string' || !VALID_AFFILIATIONS.has(value)) {
    throw validationError(
      'affiliation',
      'affiliation must be INTERNAL or EXTERNAL',
    );
  }
  return value;
}

export function validateExternalApprovalStatus(
  value: ExternalApprovalStatus,
  field: 'status' | 'externalApprovalStatus' = 'status',
): ExternalApprovalStatus {
  if (typeof value !== 'string' || !VALID_APPROVAL_STATUSES.has(value)) {
    throw validationError(
      field,
      `${field} must be PENDING, APPROVED, or REJECTED`,
    );
  }
  return value;
}

export function validateOptionalDepartmentId(
  value: number | null | undefined,
): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return validatePositiveInt4(value, 'departmentId');
}

export function validateOptionalWorkplace(
  value: string | null | undefined,
): string | null | undefined {
  return validateOptionalNullableText(value, 'workplace', 200);
}

export function validateOptionalSupervisorPhone(
  value: string | null | undefined,
): string | null | undefined {
  return validateOptionalNullableText(value, 'phone', 50);
}

export function validateOptionalSupervisorEmail(
  value: string | null | undefined,
): string | null | undefined {
  const cleaned = validateOptionalNullableText(value, 'email', 254);
  if (cleaned !== undefined && cleaned !== null && !isEmail(cleaned)) {
    throw validationError('email', 'email must be a valid email address');
  }
  return cleaned;
}

export function validateOptionalSupervisorNationalId(
  value: string | null | undefined,
): string | null | undefined {
  return validateOptionalNullableText(value, 'nationalId', 50);
}

export function validateOptionalRejectionReason(
  value: string | null | undefined,
): string | null | undefined {
  return validateOptionalNullableText(value, 'rejectionReason', 500);
}

export function validateOptionalSupervisorSearch(
  value: string | undefined,
): string | undefined {
  return validateOptionalQueryText(value, 'search');
}

export function validateOptionalSupervisorNameFilter(
  value: string | undefined,
): string | undefined {
  return validateOptionalQueryText(value, 'fullName');
}

export function validateOptionalSupervisorNationalIdFilter(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw validationError('nationalId', 'nationalId must be a string');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 50 || hasControlCharacters(trimmed)) {
    throw validationError(
      'nationalId',
      'nationalId filter must contain 1–50 printable characters',
    );
  }
  return trimmed;
}

export function validateSupervisorActivityFilter(
  value: SupervisorActivityFilter | undefined,
): SupervisorActivityFilter {
  if (value === undefined) {
    return 'ALL';
  }
  if (typeof value !== 'string' || !VALID_ACTIVITY_FILTERS.has(value)) {
    throw validationError(
      'activityStatus',
      'activityStatus must be ACTIVE, DEACTIVATED, or ALL',
    );
  }
  return value;
}

export interface SupervisorAffiliationState {
  readonly affiliation: SupervisorAffiliation;
  readonly departmentId: number | null;
  readonly workplace: string | null;
  readonly externalApprovalStatus: ExternalApprovalStatus | null;
  readonly externalRejectionReason: string | null;
}

export function resolveSupervisorAffiliationFields(
  before: SupervisorAffiliationState | null,
  patch: {
    readonly affiliation?: SupervisorAffiliation;
    readonly departmentId?: number | null;
    readonly workplace?: string | null;
  },
): SupervisorAffiliationState {
  const nextAffiliation = patch.affiliation ?? before?.affiliation;
  if (!nextAffiliation) {
    throw validationError(
      'affiliation',
      'affiliation must be INTERNAL or EXTERNAL',
    );
  }

  if (nextAffiliation === SupervisorAffiliation.INTERNAL) {
    if (patch.workplace !== undefined && patch.workplace !== null) {
      throw validationError(
        'workplace',
        'workplace cannot be set for INTERNAL supervisors',
      );
    }
    const nextDepartmentId =
      patch.departmentId !== undefined
        ? patch.departmentId
        : (before?.departmentId ?? null);
    if (nextDepartmentId === null) {
      throw validationError(
        'departmentId',
        'departmentId is required for INTERNAL supervisors',
      );
    }
    return {
      affiliation: SupervisorAffiliation.INTERNAL,
      departmentId: nextDepartmentId,
      workplace: null,
      externalApprovalStatus: null,
      externalRejectionReason: null,
    };
  }

  const nextWorkplace =
    patch.workplace !== undefined
      ? patch.workplace
      : (before?.workplace ?? null);
  if (nextWorkplace === null) {
    throw validationError(
      'workplace',
      'workplace is required for EXTERNAL supervisors',
    );
  }

  const isTransitionToExternal =
    before === null || before.affiliation === SupervisorAffiliation.INTERNAL;

  const nextDepartmentId =
    patch.departmentId !== undefined
      ? patch.departmentId
      : isTransitionToExternal
        ? null
        : before.departmentId;

  return {
    affiliation: SupervisorAffiliation.EXTERNAL,
    departmentId: nextDepartmentId,
    workplace: nextWorkplace,
    externalApprovalStatus: isTransitionToExternal
      ? ExternalApprovalStatus.PENDING
      : (before.externalApprovalStatus ?? ExternalApprovalStatus.PENDING),
    externalRejectionReason: isTransitionToExternal
      ? null
      : before.externalRejectionReason,
  };
}

export function buildSupervisorOrderBy(
  sortBy: SupervisorSortField | undefined,
  sortOrder: SortDirection | undefined,
): Prisma.SupervisorOrderByWithRelationInput[] {
  const field = sortBy ?? 'fullName';
  if (!SUPERVISOR_SORT_FIELDS.includes(field)) {
    throw validationError('sortBy', 'Unsupported sortBy field');
  }
  const direction = sortOrder ?? 'asc';
  if (direction !== 'asc' && direction !== 'desc') {
    throw validationError('sortOrder', 'sortOrder must be asc or desc');
  }
  if (field === 'id') {
    return [{ id: direction }];
  }
  return [{ [field]: direction }, { id: 'asc' }];
}

export function supervisorDepartmentNotInOperatingFacultyError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.SUPERVISOR_DEPARTMENT_NOT_IN_OPERATING_FACULTY,
    'Internal supervisors must belong to a department in the operating faculty',
  );
}

export function supervisorNotExternalError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.SUPERVISOR_NOT_EXTERNAL,
    'External approval only applies to EXTERNAL supervisors',
  );
}

export function supervisorApprovalRequiresDocumentError(
  message = 'External supervisor approval requires at least one unarchived supporting document',
): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.SUPERVISOR_APPROVAL_REQUIRES_DOCUMENT,
    message,
  );
}

export function supervisorAlreadyDeactivatedError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.SUPERVISOR_ALREADY_DEACTIVATED,
    'Supervisor record is already deactivated',
  );
}
