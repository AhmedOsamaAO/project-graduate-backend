import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../common/http/page-query.dto';
import { MAX_POSTGRES_INT4 } from '../common/http/parse-positive-int.pipe';
import { InstitutionType } from '../generated/prisma/client';

export const INSTITUTION_SORT_FIELDS = [
  'name',
  'institutionType',
  'createdAt',
  'id',
] as const;
export type InstitutionSortField = (typeof INSTITUTION_SORT_FIELDS)[number];

export const FACULTY_AND_DEPARTMENT_SORT_FIELDS = [
  'name',
  'createdAt',
  'id',
] as const;
export type CatalogSortField =
  (typeof FACULTY_AND_DEPARTMENT_SORT_FIELDS)[number];

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

const VALID_INSTITUTION_TYPES = new Set<string>(Object.values(InstitutionType));

export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

export function validateCatalogName(value: string, field: string): string {
  if (typeof value !== 'string') {
    throw validationError(field, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || hasControlCharacters(trimmed)) {
    throw validationError(
      field,
      `${field} must contain 1–200 printable characters`,
    );
  }
  return trimmed;
}

export function validateOptionalSearch(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw validationError('search', 'search must be a string');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 200 || hasControlCharacters(trimmed)) {
    throw validationError(
      'search',
      'search must contain at most 200 printable characters',
    );
  }
  return trimmed;
}

export function validatePositiveInt4(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_POSTGRES_INT4) {
    throw validationError(field, `${field} must be a positive integer`);
  }
  return value;
}

export function validateInstitutionType(
  value: InstitutionType,
): InstitutionType {
  if (typeof value !== 'string' || !VALID_INSTITUTION_TYPES.has(value)) {
    throw validationError(
      'institutionType',
      'institutionType must be a valid InstitutionType',
    );
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

export function buildOrderBy<Field extends string>(
  sortBy: Field | undefined,
  sortOrder: SortDirection | undefined,
  allowedFields: readonly Field[],
): Array<Record<string, SortDirection>> {
  const field = sortBy ?? ('name' as Field);
  if (!allowedFields.includes(field)) {
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

export function fixedRecordProtectedError(message: string): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.FIXED_RECORD_PROTECTED,
    message,
  );
}

export function recordInUseError(message: string): ApiError {
  return new ApiError(HttpStatus.CONFLICT, ERROR_CODES.RECORD_IN_USE, message);
}
