import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import { DegreeLevel, EquivalencyStatus } from '../generated/prisma/client';
import {
  assertEquivalencyDetailsConsistent,
  buildQualificationOrderBy,
  validateDegreeLevel,
  validateEquivalencyStatus,
  validateOptionalCatalogReferenceId,
  validateOptionalDecisionDate,
  validateOptionalDecisionNumber,
  validateOptionalDegreeLevelFilter,
  validateOptionalEquivalencyStatusFilter,
  validateOptionalGraduationYear,
  validateOptionalOverallGrade,
  validateOptionalQualificationName,
} from './qualifications.validation';

describe('qualifications.validation', () => {
  describe('degree level', () => {
    it('accepts all confirmed DegreeLevel enum values and rejects invalid values', () => {
      for (const level of [
        DegreeLevel.BACHELOR,
        DegreeLevel.MASTER,
        DegreeLevel.PHD,
        DegreeLevel.PROFESSIONAL,
      ]) {
        expect(validateDegreeLevel(level)).toBe(level);
        expect(validateOptionalDegreeLevelFilter(level)).toBe(level);
      }

      expect(validateOptionalDegreeLevelFilter(undefined)).toBeUndefined();
      expect(() =>
        validateDegreeLevel('bachelor' as unknown as DegreeLevel),
      ).toThrow(ApiError);
      expect(() =>
        validateDegreeLevel(undefined as unknown as DegreeLevel),
      ).toThrow(ApiError);
      expect(() =>
        validateOptionalDegreeLevelFilter(null as unknown as DegreeLevel),
      ).toThrow(ApiError);
    });
  });

  describe('optional qualification details', () => {
    it('validates qualificationName and overallGrade with trimming and null clearing', () => {
      expect(validateOptionalQualificationName(undefined)).toBeUndefined();
      expect(validateOptionalQualificationName(null)).toBeNull();
      expect(
        validateOptionalQualificationName('  B.Sc. in Computer Science  '),
      ).toBe('B.Sc. in Computer Science');
      expect(() => validateOptionalQualificationName('')).toThrow(ApiError);
      expect(() => validateOptionalQualificationName('   ')).toThrow(ApiError);
      expect(() => validateOptionalQualificationName('a'.repeat(201))).toThrow(
        ApiError,
      );
      expect(() => validateOptionalQualificationName('Bad\nTitle')).toThrow(
        ApiError,
      );

      expect(validateOptionalOverallGrade(undefined)).toBeUndefined();
      expect(validateOptionalOverallGrade(null)).toBeNull();
      expect(
        validateOptionalOverallGrade('  Very Good with Honors (3.65)  '),
      ).toBe('Very Good with Honors (3.65)');
      expect(() => validateOptionalOverallGrade('   ')).toThrow(ApiError);
      expect(() => validateOptionalOverallGrade('g'.repeat(101))).toThrow(
        ApiError,
      );
      expect(() => validateOptionalOverallGrade('Grade\u0000')).toThrow(
        ApiError,
      );
    });

    it('validates optional catalog reference IDs while preserving undefined and null', () => {
      expect(
        validateOptionalCatalogReferenceId(undefined, 'institutionId'),
      ).toBeUndefined();
      expect(
        validateOptionalCatalogReferenceId(null, 'institutionId'),
      ).toBeNull();
      expect(validateOptionalCatalogReferenceId(1, 'institutionId')).toBe(1);
      expect(() =>
        validateOptionalCatalogReferenceId(0, 'institutionId'),
      ).toThrow(ApiError);
      expect(() => validateOptionalCatalogReferenceId(-5, 'facultyId')).toThrow(
        ApiError,
      );
      expect(() =>
        validateOptionalCatalogReferenceId(1.5, 'departmentId'),
      ).toThrow(ApiError);
    });

    it('validates graduationYear as a positive Gregorian year no later than current Africa/Cairo year', () => {
      // 2026-12-31T21:59:59.999Z -> Cairo year 2026
      const year2026 = new Date('2026-12-31T21:59:59.999Z');
      // 2026-12-31T22:00:00.000Z -> Cairo year 2027
      const year2027 = new Date('2026-12-31T22:00:00.000Z');

      expect(
        validateOptionalGraduationYear(undefined, year2026),
      ).toBeUndefined();
      expect(validateOptionalGraduationYear(null, year2026)).toBeNull();
      expect(validateOptionalGraduationYear(1, year2026)).toBe(1);
      expect(validateOptionalGraduationYear(2026, year2026)).toBe(2026);
      expect(validateOptionalGraduationYear(2027, year2027)).toBe(2027);

      for (const bad of [0, -1, 2027, 2024.5, '2024']) {
        expect(() =>
          validateOptionalGraduationYear(bad as unknown as number, year2026),
        ).toThrow(ApiError);
      }
    });
  });

  describe('equivalency validation and consistency', () => {
    it('validates EquivalencyStatus values and filter', () => {
      for (const status of [
        EquivalencyStatus.NOT_ASSESSED,
        EquivalencyStatus.NOT_REQUIRED,
        EquivalencyStatus.REQUIRED,
        EquivalencyStatus.PENDING,
        EquivalencyStatus.APPROVED,
        EquivalencyStatus.REJECTED,
      ]) {
        expect(validateEquivalencyStatus(status)).toBe(status);
        expect(validateOptionalEquivalencyStatusFilter(status)).toBe(status);
      }

      expect(
        validateOptionalEquivalencyStatusFilter(undefined),
      ).toBeUndefined();
      expect(() =>
        validateEquivalencyStatus('UNKNOWN' as unknown as EquivalencyStatus),
      ).toThrow(ApiError);
    });

    it('validates equivalency decision number and decision date against Africa/Cairo today', () => {
      const now = new Date('2026-01-15T22:00:00.000Z'); // Cairo date: 2026-01-16
      expect(validateOptionalDecisionNumber(undefined)).toBeUndefined();
      expect(validateOptionalDecisionNumber(null)).toBeNull();
      expect(validateOptionalDecisionNumber('  EQ-2026/104  ')).toBe(
        'EQ-2026/104',
      );
      expect(() => validateOptionalDecisionNumber('   ')).toThrow(ApiError);
      expect(() => validateOptionalDecisionNumber('x'.repeat(101))).toThrow(
        ApiError,
      );

      expect(validateOptionalDecisionDate(undefined, now)).toBeUndefined();
      expect(validateOptionalDecisionDate(null, now)).toBeNull();
      expect(
        validateOptionalDecisionDate('2026-01-16', now)?.toISOString(),
      ).toBe('2026-01-16T00:00:00.000Z');
      expect(() => validateOptionalDecisionDate('2026-01-17', now)).toThrow(
        ApiError,
      );
      expect(() => validateOptionalDecisionDate('2023-02-29', now)).toThrow(
        ApiError,
      );
    });

    it('requires decision number and non-future decision date when APPROVED, and allows omitting them otherwise', () => {
      const now = new Date('2026-11-27T12:00:00.000Z');
      const validDate = new Date('2026-11-27T00:00:00.000Z');
      const futureDate = new Date('2026-11-28T00:00:00.000Z');

      expect(() =>
        assertEquivalencyDetailsConsistent(
          EquivalencyStatus.APPROVED,
          'DEC-1',
          validDate,
          now,
        ),
      ).not.toThrow();

      for (const status of [
        EquivalencyStatus.NOT_ASSESSED,
        EquivalencyStatus.NOT_REQUIRED,
        EquivalencyStatus.REQUIRED,
        EquivalencyStatus.PENDING,
        EquivalencyStatus.REJECTED,
      ]) {
        expect(() =>
          assertEquivalencyDetailsConsistent(status, null, null, now),
        ).not.toThrow();
        expect(() =>
          assertEquivalencyDetailsConsistent(status, 'DEC-1', validDate, now),
        ).not.toThrow();
      }

      try {
        assertEquivalencyDetailsConsistent(
          EquivalencyStatus.APPROVED,
          null,
          null,
          now,
        );
        fail('Expected missing APPROVED details to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const apiError = error as ApiError;
        expect(apiError.code).toBe(ERROR_CODES.VALIDATION_ERROR);
        expect(apiError.getResponse()).toEqual({
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'Validation failed',
          details: [
            {
              field: 'equivalencyDecisionNumber',
              message:
                'equivalencyDecisionNumber is required when equivalencyStatus is APPROVED',
            },
            {
              field: 'equivalencyDecisionDate',
              message:
                'equivalencyDecisionDate is required when equivalencyStatus is APPROVED',
            },
          ],
        });
      }

      expect(() =>
        assertEquivalencyDetailsConsistent(
          EquivalencyStatus.APPROVED,
          'DEC-1',
          futureDate,
          now,
        ),
      ).toThrow(ApiError);
    });
  });

  describe('sorting', () => {
    it('builds deterministic sort clauses with id tie-breaker and nulls-last for graduationYear', () => {
      expect(buildQualificationOrderBy(undefined, undefined)).toEqual([
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
      expect(buildQualificationOrderBy('graduationYear', 'desc')).toEqual([
        { graduationYear: { sort: 'desc', nulls: 'last' } },
        { id: 'asc' },
      ]);
      expect(buildQualificationOrderBy('degreeLevel', 'asc')).toEqual([
        { degreeLevel: 'asc' },
        { id: 'asc' },
      ]);
      expect(buildQualificationOrderBy('id', 'desc')).toEqual([{ id: 'desc' }]);
      expect(() =>
        buildQualificationOrderBy('invalid' as unknown as 'id', 'asc'),
      ).toThrow(ApiError);
      expect(() =>
        buildQualificationOrderBy('id', 'sideways' as unknown as 'asc'),
      ).toThrow(ApiError);
    });
  });
});
