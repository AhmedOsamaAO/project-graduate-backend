import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import { MilitaryStatus } from '../generated/prisma/client';
import {
  buildStudentOrderBy,
  extractNationalIdSearchDigits,
  normalizeArabicIndicDigits,
  normalizePagination,
  validateArchiveFilter,
  validateMilitaryStatusFilter,
  validateOptionalAddress,
  validateOptionalBirthDate,
  validateOptionalMilitaryStatus,
  validateOptionalNameFilter,
  validateOptionalNationalIdFilter,
  validateOptionalPhone,
  validateOptionalSearch,
  validatePositiveInt4,
  validateStudentFullName,
  validateStudentNationalId,
} from './students.validation';

describe('students.validation', () => {
  describe('normalizeArabicIndicDigits', () => {
    it('converts Arabic-Indic digits (٠-٩) to ASCII 0-9 while preserving other characters', () => {
      expect(normalizeArabicIndicDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
      expect(normalizeArabicIndicDigits('٠٠١٢٣456٧٨٩٠١٢')).toBe(
        '00123456789012',
      );
      expect(normalizeArabicIndicDigits('abc-٠٥')).toBe('abc-05');
    });
  });

  describe('validateStudentFullName', () => {
    it('accepts trimmed Arabic and Latin names regardless of word count', () => {
      expect(validateStudentFullName('  أحمد  ')).toBe('أحمد');
      expect(validateStudentFullName('  أحمد أسامة علي  ')).toBe(
        'أحمد أسامة علي',
      );
      expect(validateStudentFullName('  Nora  ')).toBe('Nora');
      expect(validateStudentFullName("Jean-Luc O'Connor")).toBe(
        "Jean-Luc O'Connor",
      );
    });

    it('rejects empty, whitespace-only, non-string, oversized, or control-char names', () => {
      for (const bad of ['', '   ', '\t\n', 'x'.repeat(201), 'Ali\u0007']) {
        expect(() => validateStudentFullName(bad)).toThrow(ApiError);
      }
      expect(() => validateStudentFullName(123 as unknown as string)).toThrow(
        ApiError,
      );
    });
  });

  describe('validateStudentNationalId', () => {
    it('normalizes Arabic-Indic digits, preserves leading zeros, and infers nothing', () => {
      expect(validateStudentNationalId('  ٠٠١٢٣٤٥٦٧٨٩٠١٢  ')).toBe(
        '00123456789012',
      );
      // Year/century/governorate digits are never inferred or rejected if 14 digits
      expect(validateStudentNationalId('00000000000000')).toBe(
        '00000000000000',
      );
      expect(validateStudentNationalId('99999999999999')).toBe(
        '99999999999999',
      );
      expect(validateStudentNationalId('29901011234567')).toBe(
        '29901011234567',
      );
    });

    it('rejects numbers, wrong lengths, separators, and non-digit characters', () => {
      for (const bad of [
        '',
        '   ',
        '1234567890123',
        '123456789012345',
        '2990101-1234567',
        '2990101 1234567',
        '2990101123456a',
        '۲۹۹۰۱۰۱۱۲۳۴۵۶۷', // Persian/Extended Arabic-Indic digits
      ]) {
        try {
          validateStudentNationalId(bad);
          fail(`Expected ${bad} to throw`);
        } catch (error) {
          expect(error).toBeInstanceOf(ApiError);
          expect((error as ApiError).code).toBe(ERROR_CODES.VALIDATION_ERROR);
        }
      }

      expect(() =>
        validateStudentNationalId(29901011234567 as unknown as string),
      ).toThrow(ApiError);
    });
  });

  describe('optional fields', () => {
    it('validates optional phone and address while preserving null for clearing', () => {
      expect(validateOptionalPhone(undefined)).toBeUndefined();
      expect(validateOptionalPhone(null)).toBeNull();
      expect(validateOptionalPhone('  01001234567  ')).toBe('01001234567');
      expect(() => validateOptionalPhone('')).toThrow(ApiError);
      expect(() => validateOptionalPhone('   ')).toThrow(ApiError);
      expect(() => validateOptionalPhone('1'.repeat(51))).toThrow(ApiError);
      expect(() =>
        validateOptionalPhone(1001234567 as unknown as string),
      ).toThrow(ApiError);

      expect(validateOptionalAddress(undefined)).toBeUndefined();
      expect(validateOptionalAddress(null)).toBeNull();
      expect(validateOptionalAddress('  Zagazig, Sharqia  ')).toBe(
        'Zagazig, Sharqia',
      );
      expect(() => validateOptionalAddress('')).toThrow(ApiError);
      expect(() => validateOptionalAddress('a'.repeat(501))).toThrow(ApiError);
    });

    it('validates optional birthDate against Africa/Cairo office today', () => {
      // 2026-01-15T22:00:00Z -> 2026-01-16 in Africa/Cairo
      const now = new Date('2026-01-15T22:00:00.000Z');
      expect(validateOptionalBirthDate(undefined, now)).toBeUndefined();
      expect(validateOptionalBirthDate(null, now)).toBeNull();

      const todayBirth = validateOptionalBirthDate('2026-01-16', now);
      expect(todayBirth?.toISOString()).toBe('2026-01-16T00:00:00.000Z');

      expect(() => validateOptionalBirthDate('2026-01-17', now)).toThrow(
        ApiError,
      );
      expect(() => validateOptionalBirthDate('2024-02-30', now)).toThrow(
        ApiError,
      );
      expect(() => validateOptionalBirthDate('2023-02-29', now)).toThrow(
        ApiError,
      );
    });

    it('requires uppercase MilitaryStatus enum values or null', () => {
      expect(validateOptionalMilitaryStatus(undefined)).toBeUndefined();
      expect(validateOptionalMilitaryStatus(null)).toBeNull();
      expect(validateOptionalMilitaryStatus(MilitaryStatus.COMPLETED)).toBe(
        'COMPLETED',
      );
      expect(validateOptionalMilitaryStatus(MilitaryStatus.EXEMPTED)).toBe(
        'EXEMPTED',
      );
      expect(validateOptionalMilitaryStatus(MilitaryStatus.POSTPONED)).toBe(
        'POSTPONED',
      );
      expect(() =>
        validateOptionalMilitaryStatus(
          'Completed' as unknown as MilitaryStatus,
        ),
      ).toThrow(ApiError);
      expect(validateMilitaryStatusFilter(undefined)).toBeUndefined();
      expect(validateMilitaryStatusFilter(MilitaryStatus.POSTPONED)).toBe(
        'POSTPONED',
      );
      expect(() =>
        validateMilitaryStatusFilter(null as unknown as MilitaryStatus),
      ).toThrow(ApiError);
    });
  });

  describe('search, filter, pagination, and sorting helpers', () => {
    it('validates search and name filters and detects digit-only search terms', () => {
      expect(validateOptionalSearch(undefined)).toBeUndefined();
      expect(validateOptionalSearch('   ')).toBeUndefined();
      expect(validateOptionalSearch('  ٠٠١٢  ')).toBe('٠٠١٢');
      expect(() => validateOptionalSearch('x'.repeat(201))).toThrow(ApiError);
      expect(extractNationalIdSearchDigits('٠٠١٢')).toBe('0012');
      expect(extractNationalIdSearchDigits('أحمد')).toBeNull();

      expect(validateOptionalNameFilter('  سارة  ')).toBe('سارة');
      expect(validateOptionalNameFilter('   ')).toBeUndefined();
    });

    it('normalizes nationalId filter digits and preserves leading zeros', () => {
      expect(validateOptionalNationalIdFilter(undefined)).toBeUndefined();
      expect(validateOptionalNationalIdFilter('   ')).toBeUndefined();
      expect(validateOptionalNationalIdFilter('  ٠٠١٢٣  ')).toBe('00123');
      expect(() => validateOptionalNationalIdFilter('abc')).toThrow(ApiError);
      expect(() => validateOptionalNationalIdFilter('123456789012345')).toThrow(
        ApiError,
      );
    });

    it('validates archive filter, positive int4, pagination, and deterministic sorting', () => {
      expect(validateArchiveFilter(undefined)).toBe('ACTIVE');
      expect(validateArchiveFilter('ARCHIVED')).toBe('ARCHIVED');
      expect(validateArchiveFilter('ALL')).toBe('ALL');
      expect(() =>
        validateArchiveFilter('DELETED' as unknown as 'ACTIVE'),
      ).toThrow(ApiError);

      expect(validatePositiveInt4(1, 'id')).toBe(1);
      expect(() => validatePositiveInt4(0, 'id')).toThrow(ApiError);

      expect(normalizePagination({})).toEqual({ page: 1, pageSize: 20 });
      expect(() => normalizePagination({ pageSize: 101 })).toThrow(ApiError);

      expect(buildStudentOrderBy(undefined, undefined)).toEqual([
        { fullName: 'asc' },
        { id: 'asc' },
      ]);
      expect(buildStudentOrderBy('nationalId', 'desc')).toEqual([
        { nationalId: 'desc' },
        { id: 'asc' },
      ]);
      expect(buildStudentOrderBy('id', 'desc')).toEqual([{ id: 'desc' }]);
    });
  });
});
