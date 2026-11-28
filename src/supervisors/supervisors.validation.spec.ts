import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  AcademicRank,
  ExternalApprovalStatus,
  SupervisorAffiliation,
} from '../generated/prisma/client';
import {
  buildSupervisorOrderBy,
  resolveSupervisorAffiliationFields,
  validateAcademicRank,
  validateExternalApprovalStatus,
  validateOptionalDepartmentId,
  validateOptionalRejectionReason,
  validateOptionalSupervisorEmail,
  validateOptionalSupervisorNationalId,
  validateOptionalSupervisorNationalIdFilter,
  validateOptionalSupervisorPhone,
  validateOptionalWorkplace,
  validateSupervisorActivityFilter,
  validateSupervisorAffiliation,
  validateSupervisorFullName,
} from './supervisors.validation';

function expectApiErrorCode(fn: () => unknown, expectedCode: string): void {
  try {
    fn();
    throw new Error(`Expected ApiError(${expectedCode}), but succeeded`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(expectedCode);
  }
}

describe('supervisors validation', () => {
  it('validates all four academic ranks, affiliations, approval statuses, and supervisor full name', () => {
    for (const rank of Object.values(AcademicRank)) {
      expect(validateAcademicRank(rank)).toBe(rank);
    }
    expectApiErrorCode(
      () => validateAcademicRank('DEAN' as AcademicRank),
      ERROR_CODES.VALIDATION_ERROR,
    );

    expect(validateSupervisorAffiliation(SupervisorAffiliation.INTERNAL)).toBe(
      SupervisorAffiliation.INTERNAL,
    );
    expect(validateSupervisorAffiliation(SupervisorAffiliation.EXTERNAL)).toBe(
      SupervisorAffiliation.EXTERNAL,
    );
    expectApiErrorCode(
      () => validateSupervisorAffiliation('VISITING' as SupervisorAffiliation),
      ERROR_CODES.VALIDATION_ERROR,
    );

    for (const status of Object.values(ExternalApprovalStatus)) {
      expect(validateExternalApprovalStatus(status)).toBe(status);
    }
    expectApiErrorCode(
      () =>
        validateExternalApprovalStatus('WITHDRAWN' as ExternalApprovalStatus),
      ERROR_CODES.VALIDATION_ERROR,
    );

    expect(validateSupervisorFullName('  د. هالة مصطفى  ')).toBe(
      'د. هالة مصطفى',
    );
    expectApiErrorCode(
      () => validateSupervisorFullName('   '),
      ERROR_CODES.VALIDATION_ERROR,
    );
    expectApiErrorCode(
      () => validateSupervisorFullName('a'.repeat(201)),
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('allows optional non-Egyptian and leading-zero national IDs, valid emails, phones, workplaces, and rejection reasons', () => {
    expect(validateOptionalSupervisorNationalId(undefined)).toBeUndefined();
    expect(validateOptionalSupervisorNationalId(null)).toBeNull();
    expect(validateOptionalSupervisorNationalId('  0012345  ')).toBe('0012345');
    expect(validateOptionalSupervisorNationalId('  AB-99881-X  ')).toBe(
      'AB-99881-X',
    );
    expectApiErrorCode(
      () => validateOptionalSupervisorNationalId('   '),
      ERROR_CODES.VALIDATION_ERROR,
    );
    expectApiErrorCode(
      () => validateOptionalSupervisorNationalId('x'.repeat(51)),
      ERROR_CODES.VALIDATION_ERROR,
    );

    expect(validateOptionalSupervisorNationalIdFilter('  0012  ')).toBe('0012');
    expect(validateOptionalSupervisorNationalIdFilter('   ')).toBeUndefined();
    expectApiErrorCode(
      () => validateOptionalSupervisorNationalIdFilter('x'.repeat(51)),
      ERROR_CODES.VALIDATION_ERROR,
    );

    expect(validateOptionalSupervisorEmail('  prof@zu.edu.eg  ')).toBe(
      'prof@zu.edu.eg',
    );
    expect(validateOptionalSupervisorEmail(null)).toBeNull();
    expectApiErrorCode(
      () => validateOptionalSupervisorEmail('not-an-email'),
      ERROR_CODES.VALIDATION_ERROR,
    );

    expect(validateOptionalSupervisorPhone('  +201001234567  ')).toBe(
      '+201001234567',
    );
    expect(validateOptionalWorkplace('  Cairo University  ')).toBe(
      'Cairo University',
    );
    expect(validateOptionalRejectionReason('  Missing endorsement  ')).toBe(
      'Missing endorsement',
    );
    expect(validateOptionalDepartmentId(null)).toBeNull();
    expect(validateOptionalDepartmentId(3)).toBe(3);
  });

  it('resolves INTERNAL and EXTERNAL affiliation fields on create and update transitions', () => {
    expect(
      resolveSupervisorAffiliationFields(null, {
        affiliation: SupervisorAffiliation.INTERNAL,
        departmentId: 4,
      }),
    ).toEqual({
      affiliation: SupervisorAffiliation.INTERNAL,
      departmentId: 4,
      workplace: null,
      externalApprovalStatus: null,
      externalRejectionReason: null,
    });

    expectApiErrorCode(
      () =>
        resolveSupervisorAffiliationFields(null, {
          affiliation: SupervisorAffiliation.INTERNAL,
          departmentId: 4,
          workplace: 'Some Lab',
        }),
      ERROR_CODES.VALIDATION_ERROR,
    );
    expectApiErrorCode(
      () =>
        resolveSupervisorAffiliationFields(null, {
          affiliation: SupervisorAffiliation.INTERNAL,
          departmentId: null,
        }),
      ERROR_CODES.VALIDATION_ERROR,
    );

    expect(
      resolveSupervisorAffiliationFields(null, {
        affiliation: SupervisorAffiliation.EXTERNAL,
        workplace: 'Ain Shams University',
      }),
    ).toEqual({
      affiliation: SupervisorAffiliation.EXTERNAL,
      departmentId: null,
      workplace: 'Ain Shams University',
      externalApprovalStatus: ExternalApprovalStatus.PENDING,
      externalRejectionReason: null,
    });

    expectApiErrorCode(
      () =>
        resolveSupervisorAffiliationFields(null, {
          affiliation: SupervisorAffiliation.EXTERNAL,
          departmentId: 9,
        }),
      ERROR_CODES.VALIDATION_ERROR,
    );

    // Switching INTERNAL -> EXTERNAL clears omitted departmentId and resets approval to PENDING
    expect(
      resolveSupervisorAffiliationFields(
        {
          affiliation: SupervisorAffiliation.INTERNAL,
          departmentId: 2,
          workplace: null,
          externalApprovalStatus: null,
          externalRejectionReason: null,
        },
        {
          affiliation: SupervisorAffiliation.EXTERNAL,
          workplace: 'Helwan University',
        },
      ),
    ).toEqual({
      affiliation: SupervisorAffiliation.EXTERNAL,
      departmentId: null,
      workplace: 'Helwan University',
      externalApprovalStatus: ExternalApprovalStatus.PENDING,
      externalRejectionReason: null,
    });

    // Staying EXTERNAL -> EXTERNAL preserves approval status, rejection reason, and optional departmentId
    expect(
      resolveSupervisorAffiliationFields(
        {
          affiliation: SupervisorAffiliation.EXTERNAL,
          departmentId: 9,
          workplace: 'Old Lab',
          externalApprovalStatus: ExternalApprovalStatus.APPROVED,
          externalRejectionReason: null,
        },
        {
          workplace: 'New Lab',
        },
      ),
    ).toEqual({
      affiliation: SupervisorAffiliation.EXTERNAL,
      departmentId: 9,
      workplace: 'New Lab',
      externalApprovalStatus: ExternalApprovalStatus.APPROVED,
      externalRejectionReason: null,
    });

    // Switching EXTERNAL -> INTERNAL clears workplace and external approval fields
    expect(
      resolveSupervisorAffiliationFields(
        {
          affiliation: SupervisorAffiliation.EXTERNAL,
          departmentId: 9,
          workplace: 'Old Lab',
          externalApprovalStatus: ExternalApprovalStatus.REJECTED,
          externalRejectionReason: 'Incomplete doc',
        },
        {
          affiliation: SupervisorAffiliation.INTERNAL,
          departmentId: 2,
        },
      ),
    ).toEqual({
      affiliation: SupervisorAffiliation.INTERNAL,
      departmentId: 2,
      workplace: null,
      externalApprovalStatus: null,
      externalRejectionReason: null,
    });
  });

  it('defaults activity filter to ALL and builds deterministic sort orders', () => {
    expect(validateSupervisorActivityFilter(undefined)).toBe('ALL');
    expect(validateSupervisorActivityFilter('ACTIVE')).toBe('ACTIVE');
    expectApiErrorCode(
      () => validateSupervisorActivityFilter('ARCHIVED' as 'ALL'),
      ERROR_CODES.VALIDATION_ERROR,
    );

    expect(buildSupervisorOrderBy(undefined, undefined)).toEqual([
      { fullName: 'asc' },
      { id: 'asc' },
    ]);
    expect(buildSupervisorOrderBy('id', 'desc')).toEqual([{ id: 'desc' }]);
    expect(buildSupervisorOrderBy('nationalId', 'desc')).toEqual([
      { nationalId: 'desc' },
      { id: 'asc' },
    ]);
  });
});
