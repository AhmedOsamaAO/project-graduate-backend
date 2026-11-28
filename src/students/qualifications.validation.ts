import { HttpStatus } from '@nestjs/common';
import {
  formatCalendarDate,
  getOfficeCurrentYear,
  isFutureOfficeDate,
} from '../common/dates/office-calendar';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { ValidationDetail } from '../common/errors/validation-details';
import {
  DegreeLevel,
  EquivalencyStatus,
  type Prisma,
} from '../generated/prisma/client';
import {
  STUDENT_ARCHIVE_FILTERS,
  validateOptionalNullableText,
  validateOptionalOfficeDate,
  validatePositiveInt4,
  validationError,
  type SortDirection,
  type StudentArchiveFilter,
} from './students.validation';

export const QUALIFICATION_ARCHIVE_FILTERS = STUDENT_ARCHIVE_FILTERS;
export type QualificationArchiveFilter = StudentArchiveFilter;

export const QUALIFICATION_SORT_FIELDS = [
  'createdAt',
  'graduationYear',
  'degreeLevel',
  'equivalencyStatus',
  'id',
] as const;
export type QualificationSortField = (typeof QUALIFICATION_SORT_FIELDS)[number];

const VALID_DEGREE_LEVELS = new Set<string>(Object.values(DegreeLevel));
const VALID_EQUIVALENCY_STATUSES = new Set<string>(
  Object.values(EquivalencyStatus),
);

export function validateDegreeLevel(value: DegreeLevel): DegreeLevel {
  if (typeof value !== 'string' || !VALID_DEGREE_LEVELS.has(value)) {
    throw validationError(
      'degreeLevel',
      'degreeLevel must be BACHELOR, MASTER, PHD, or PROFESSIONAL',
    );
  }
  return value;
}

export function validateOptionalBoolean(
  value: boolean | undefined,
  field: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw validationError(field, `${field} must be a boolean`);
  }
  return value;
}

export function validateOptionalDegreeLevelFilter(
  value: DegreeLevel | undefined,
): DegreeLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  return validateDegreeLevel(value);
}

export function validateOptionalQualificationName(
  value: string | null | undefined,
): string | null | undefined {
  return validateOptionalNullableText(value, 'qualificationName', 200);
}

export function validateOptionalOverallGrade(
  value: string | null | undefined,
): string | null | undefined {
  return validateOptionalNullableText(value, 'overallGrade', 100);
}

export function validateOptionalCatalogReferenceId(
  value: number | null | undefined,
  field: 'institutionId' | 'facultyId' | 'departmentId',
): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return validatePositiveInt4(value, field);
}

export function validateOptionalGraduationYear(
  value: number | null | undefined,
  now: Date = new Date(),
): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError(
      'graduationYear',
      'graduationYear must be a positive Gregorian year',
    );
  }
  const currentYear = getOfficeCurrentYear(now);
  if (value > currentYear) {
    throw validationError(
      'graduationYear',
      `graduationYear cannot be later than ${currentYear} for Africa/Cairo`,
    );
  }
  return value;
}

export function validateEquivalencyStatus(
  value: EquivalencyStatus,
): EquivalencyStatus {
  if (typeof value !== 'string' || !VALID_EQUIVALENCY_STATUSES.has(value)) {
    throw validationError(
      'equivalencyStatus',
      'equivalencyStatus must be NOT_ASSESSED, NOT_REQUIRED, REQUIRED, PENDING, APPROVED, or REJECTED',
    );
  }
  return value;
}

export function validateOptionalEquivalencyStatusFilter(
  value: EquivalencyStatus | undefined,
): EquivalencyStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  return validateEquivalencyStatus(value);
}

export function validateOptionalDecisionNumber(
  value: string | null | undefined,
): string | null | undefined {
  return validateOptionalNullableText(value, 'equivalencyDecisionNumber', 100);
}

export function validateOptionalDecisionDate(
  value: string | null | undefined,
  now: Date = new Date(),
): Date | null | undefined {
  return validateOptionalOfficeDate(value, 'equivalencyDecisionDate', now);
}

export function assertEquivalencyDetailsConsistent(
  status: EquivalencyStatus,
  decisionNumber: string | null,
  decisionDate: Date | null,
  now: Date = new Date(),
): void {
  if (
    decisionDate !== null &&
    isFutureOfficeDate(formatCalendarDate(decisionDate), now)
  ) {
    throw validationError(
      'equivalencyDecisionDate',
      'equivalencyDecisionDate cannot be in the future for Africa/Cairo',
    );
  }

  if (status !== EquivalencyStatus.APPROVED) {
    return;
  }

  const details: ValidationDetail[] = [];
  if (decisionNumber === null) {
    details.push({
      field: 'equivalencyDecisionNumber',
      message:
        'equivalencyDecisionNumber is required when equivalencyStatus is APPROVED',
    });
  }
  if (decisionDate === null) {
    details.push({
      field: 'equivalencyDecisionDate',
      message:
        'equivalencyDecisionDate is required when equivalencyStatus is APPROVED',
    });
  }

  if (details.length > 0) {
    throw new ApiError(
      HttpStatus.BAD_REQUEST,
      ERROR_CODES.VALIDATION_ERROR,
      'Validation failed',
      details,
    );
  }
}

export function buildQualificationOrderBy(
  sortBy: QualificationSortField | undefined,
  sortOrder: SortDirection | undefined,
): Prisma.StudentQualificationOrderByWithRelationInput[] {
  const field = sortBy ?? 'createdAt';
  if (!QUALIFICATION_SORT_FIELDS.includes(field)) {
    throw validationError('sortBy', 'Unsupported sortBy field');
  }
  const direction = sortOrder ?? 'asc';
  if (direction !== 'asc' && direction !== 'desc') {
    throw validationError('sortOrder', 'sortOrder must be asc or desc');
  }
  if (field === 'id') {
    return [{ id: direction }];
  }
  if (field === 'graduationYear') {
    return [
      { graduationYear: { sort: direction, nulls: 'last' } },
      { id: 'asc' },
    ];
  }
  return [{ [field]: direction }, { id: 'asc' }];
}

export function qualificationHierarchyConflictError(message: string): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.QUALIFICATION_HIERARCHY_CONFLICT,
    message,
  );
}

export function qualificationArchivedError(message: string): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.QUALIFICATION_ARCHIVED,
    message,
  );
}

export function qualificationAlreadyArchivedError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.QUALIFICATION_ALREADY_ARCHIVED,
    'Qualification record is already archived',
  );
}

export function qualificationNotArchivedError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.QUALIFICATION_NOT_ARCHIVED,
    'Qualification record is not archived',
  );
}
