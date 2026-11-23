import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import { MAX_POSTGRES_INT4 } from '../common/http/parse-positive-int.pipe';
import {
  FACULTY_AND_DEPARTMENT_SORT_FIELDS,
  INSTITUTION_SORT_FIELDS,
  buildOrderBy,
  normalizePagination,
  validateCatalogName,
  validateInstitutionType,
  validateOptionalSearch,
  validatePositiveInt4,
} from './reference-data.validation';

function expectValidationError(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiError);
  expect((caught as ApiError).code).toBe(ERROR_CODES.VALIDATION_ERROR);
}

describe('reference data validation and sorting helpers', () => {
  it('trims valid catalog names and rejects blank, oversized, or control-character strings', () => {
    expect(validateCatalogName('  Cairo University  ', 'name')).toBe(
      'Cairo University',
    );
    expectValidationError(() => validateCatalogName('   ', 'name'));
    expectValidationError(() => validateCatalogName('a'.repeat(201), 'name'));
    expectValidationError(() => validateCatalogName('Bad\nName', 'name'));
    expectValidationError(() => validateCatalogName('Bad\u007fName', 'name'));
  });

  it('normalizes optional search queries and rejects invalid search values', () => {
    expect(validateOptionalSearch(undefined)).toBeUndefined();
    expect(validateOptionalSearch('   ')).toBeUndefined();
    expect(validateOptionalSearch('  100% _Special  ')).toBe('100% _Special');
    expectValidationError(() => validateOptionalSearch('x'.repeat(201)));
    expectValidationError(() => validateOptionalSearch('line\rbreak'));
  });

  it('validates positive 32-bit integers', () => {
    expect(validatePositiveInt4(1, 'id')).toBe(1);
    expect(validatePositiveInt4(MAX_POSTGRES_INT4, 'id')).toBe(
      MAX_POSTGRES_INT4,
    );

    for (const invalid of [0, -1, 1.5, MAX_POSTGRES_INT4 + 1, NaN]) {
      expectValidationError(() => validatePositiveInt4(invalid, 'id'));
    }
  });

  it('validates InstitutionType enum values', () => {
    expect(validateInstitutionType('PUBLIC_UNIVERSITY')).toBe(
      'PUBLIC_UNIVERSITY',
    );
    expectValidationError(() =>
      validateInstitutionType('UNKNOWN_TYPE' as never),
    );
  });

  it('normalizes pagination defaults and rejects out-of-range page parameters', () => {
    expect(normalizePagination({})).toEqual({ page: 1, pageSize: 20 });
    expect(normalizePagination({ page: 3, pageSize: 100 })).toEqual({
      page: 3,
      pageSize: 100,
    });
    expectValidationError(() => normalizePagination({ page: 0 }));
    expectValidationError(() => normalizePagination({ pageSize: 101 }));
  });

  it('builds deterministic allowlisted sorting with an id tie-breaker', () => {
    expect(buildOrderBy(undefined, undefined, INSTITUTION_SORT_FIELDS)).toEqual(
      [{ name: 'asc' }, { id: 'asc' }],
    );
    expect(
      buildOrderBy('institutionType', 'desc', INSTITUTION_SORT_FIELDS),
    ).toEqual([{ institutionType: 'desc' }, { id: 'asc' }]);
    expect(
      buildOrderBy('id', 'desc', FACULTY_AND_DEPARTMENT_SORT_FIELDS),
    ).toEqual([{ id: 'desc' }]);

    expectValidationError(() =>
      buildOrderBy(
        'invalid' as never,
        'asc',
        FACULTY_AND_DEPARTMENT_SORT_FIELDS,
      ),
    );
    expectValidationError(() =>
      buildOrderBy(
        'name',
        'sideways' as never,
        FACULTY_AND_DEPARTMENT_SORT_FIELDS,
      ),
    );
  });
});
