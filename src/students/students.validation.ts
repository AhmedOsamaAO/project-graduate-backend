import { HttpStatus } from '@nestjs/common';
import {
  isFutureOfficeDate,
  parseCalendarDate,
} from '../common/dates/office-calendar';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../common/http/page-query.dto';
import { MAX_POSTGRES_INT4 } from '../common/http/parse-positive-int.pipe';
import { MilitaryStatus } from '../generated/prisma/client';

export const STUDENT_SORT_FIELDS = [
  'fullName',
  'nationalId',
  'createdAt',
  'id',
] as const;
export type StudentSortField = (typeof STUDENT_SORT_FIELDS)[number];

export const STUDENT_ARCHIVE_FILTERS = ['ACTIVE', 'ARCHIVED', 'ALL'] as const;
export type StudentArchiveFilter = (typeof STUDENT_ARCHIVE_FILTERS)[number];

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export const STUDENT_NATIONAL_ID_PATTERN = /^[0-9]{14}$/;
export const STUDENT_NATIONAL_ID_SEARCH_PATTERN = /^[0-9]{1,14}$/;

const VALID_MILITARY_STATUSES = new Set<string>(Object.values(MilitaryStatus));
const VALID_ARCHIVE_FILTERS = new Set<string>(STUDENT_ARCHIVE_FILTERS);

export interface ArchivedStudentConflictDetails {
  readonly studentId: number;
  readonly fullName: string;
  readonly nationalId: string;
  readonly archivedAt: string;
  readonly version: number;
  readonly requiresRestore: true;
}

/** Normalizes Arabic-Indic digits (٠–٩) to ASCII 0–9. */
export function normalizeArabicIndicDigits(value: string): string {
  return value.replace(/[\u0660-\u0669]/g, (char) =>
    String(char.charCodeAt(0) - 0x0660),
  );
}

export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

export function validateTrimmedPrintableText(
  value: string,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw validationError(field, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || hasControlCharacters(trimmed)) {
    throw validationError(
      field,
      `${field} must contain 1–${maxLength} printable characters`,
    );
  }
  return trimmed;
}

export function validateOptionalNullableText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return validateTrimmedPrintableText(value, field, maxLength);
}

export function validateOptionalQueryText(
  value: string | undefined,
  field: string,
  maxLength = 200,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw validationError(field, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > maxLength || hasControlCharacters(trimmed)) {
    throw validationError(
      field,
      `${field} must contain at most ${maxLength} printable characters`,
    );
  }
  return trimmed;
}

export function validateStudentFullName(value: string): string {
  return validateTrimmedPrintableText(value, 'fullName', 200);
}

export function validateStudentNationalId(value: string): string {
  if (typeof value !== 'string') {
    throw validationError('nationalId', 'nationalId must be a string');
  }
  const trimmed = value.trim();
  if (hasControlCharacters(trimmed)) {
    throw validationError(
      'nationalId',
      'nationalId must not contain control characters',
    );
  }
  const normalized = normalizeArabicIndicDigits(trimmed);
  if (!STUDENT_NATIONAL_ID_PATTERN.test(normalized)) {
    throw validationError(
      'nationalId',
      'nationalId must contain exactly 14 digits',
    );
  }
  return normalized;
}

export function validateOptionalPhone(
  value: string | null | undefined,
): string | null | undefined {
  return validateOptionalNullableText(value, 'phone', 50);
}

export function validateOptionalAddress(
  value: string | null | undefined,
): string | null | undefined {
  return validateOptionalNullableText(value, 'address', 500);
}

export function validateOptionalOfficeDate(
  value: string | null | undefined,
  field: string,
  now: Date = new Date(),
): Date | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== 'string') {
    throw validationError(field, `${field} must be a YYYY-MM-DD date`);
  }
  const parsed = parseCalendarDate(value);
  if (!parsed) {
    throw validationError(
      field,
      `${field} must be a valid YYYY-MM-DD calendar date`,
    );
  }
  if (isFutureOfficeDate(value, now)) {
    throw validationError(
      field,
      `${field} cannot be in the future for Africa/Cairo`,
    );
  }
  return parsed;
}

export function validateOptionalBirthDate(
  value: string | null | undefined,
  now: Date = new Date(),
): Date | null | undefined {
  return validateOptionalOfficeDate(value, 'birthDate', now);
}

export function validateOptionalMilitaryStatus(
  value: MilitaryStatus | null | undefined,
): MilitaryStatus | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return validateMilitaryStatusValue(value);
}

export function validateMilitaryStatusFilter(
  value: MilitaryStatus | undefined,
): MilitaryStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  return validateMilitaryStatusValue(value);
}

function validateMilitaryStatusValue(value: MilitaryStatus): MilitaryStatus {
  if (typeof value !== 'string' || !VALID_MILITARY_STATUSES.has(value)) {
    throw validationError(
      'militaryStatus',
      'militaryStatus must be COMPLETED, EXEMPTED, or POSTPONED',
    );
  }
  return value;
}

export function extractNationalIdSearchDigits(search: string): string | null {
  const normalized = normalizeArabicIndicDigits(search);
  return STUDENT_NATIONAL_ID_SEARCH_PATTERN.test(normalized)
    ? normalized
    : null;
}

export function validateOptionalSearch(
  value: string | undefined,
): string | undefined {
  return validateOptionalQueryText(value, 'search');
}

export function validateOptionalNameFilter(
  value: string | undefined,
): string | undefined {
  return validateOptionalQueryText(value, 'fullName');
}

export function validateOptionalNationalIdFilter(
  value: string | undefined,
): string | undefined {
  const trimmed = validateOptionalQueryText(value, 'nationalId');
  if (trimmed === undefined) {
    return undefined;
  }
  const normalized = normalizeArabicIndicDigits(trimmed);
  if (!STUDENT_NATIONAL_ID_SEARCH_PATTERN.test(normalized)) {
    throw validationError(
      'nationalId',
      'nationalId filter must contain 1–14 digits',
    );
  }
  return normalized;
}

export function validateArchiveFilter(
  value: StudentArchiveFilter | undefined,
): StudentArchiveFilter {
  if (value === undefined) {
    return 'ACTIVE';
  }
  if (typeof value !== 'string' || !VALID_ARCHIVE_FILTERS.has(value)) {
    throw validationError(
      'archiveStatus',
      'archiveStatus must be ACTIVE, ARCHIVED, or ALL',
    );
  }
  return value;
}

export function validatePositiveInt4(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_POSTGRES_INT4) {
    throw validationError(field, `${field} must be a positive integer`);
  }
  return value;
}

export function normalizePagination(query: {
  readonly page?: number;
  readonly pageSize?: number;
}): { readonly page: number; readonly pageSize: number } {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_POSTGRES_INT4) {
    throw validationError('page', 'page must be a positive integer');
  }
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_PAGE_SIZE
  ) {
    throw validationError(
      'pageSize',
      `pageSize must be between 1 and ${MAX_PAGE_SIZE}`,
    );
  }
  return { page, pageSize };
}

export function buildStudentOrderBy(
  sortBy: StudentSortField | undefined,
  sortOrder: SortDirection | undefined,
): Array<Record<string, SortDirection>> {
  const field = sortBy ?? 'fullName';
  if (!STUDENT_SORT_FIELDS.includes(field)) {
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

export function validationError(field: string, message: string): ApiError {
  return new ApiError(
    HttpStatus.BAD_REQUEST,
    ERROR_CODES.VALIDATION_ERROR,
    'Validation failed',
    [{ field, message }],
  );
}

export function notFoundError(message: string): ApiError {
  return new ApiError(HttpStatus.NOT_FOUND, ERROR_CODES.NOT_FOUND, message);
}

export function studentNationalIdExistsError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.STUDENT_NATIONAL_ID_EXISTS,
    'A student with this national ID already exists',
  );
}

export function archivedStudentNationalIdError(
  details: ArchivedStudentConflictDetails,
): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.STUDENT_NATIONAL_ID_ARCHIVED,
    'An archived student record already owns this national ID and must be restored',
    details,
  );
}

export function studentArchivedError(message: string): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.STUDENT_ARCHIVED,
    message,
  );
}

export function studentAlreadyArchivedError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.STUDENT_ALREADY_ARCHIVED,
    'Student record is already archived',
  );
}

export function studentNotArchivedError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.STUDENT_NOT_ARCHIVED,
    'Student record is not archived',
  );
}

export function documentOwnerMismatchError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.DOCUMENT_OWNER_MISMATCH,
    'Selected personal photo must belong to the same student',
  );
}

export function invalidSelectedPhotoError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.INVALID_SELECTED_PHOTO,
    'Selected personal photo must be a PERSONAL_PHOTO document',
  );
}

export function selectedPhotoDocumentArchivedError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.DOCUMENT_ARCHIVED,
    'Archived document cannot be selected as personal photo',
  );
}

export function selectedPhotoDocumentUnavailableError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.DOCUMENT_UNAVAILABLE,
    'Unavailable document cannot be selected as personal photo',
  );
}
