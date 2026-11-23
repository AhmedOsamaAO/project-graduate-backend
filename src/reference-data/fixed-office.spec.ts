import {
  FIXED_OFFICE,
  assertFixedOfficeHierarchy,
  isFixedFacultyId,
  isFixedInstitutionId,
} from './fixed-office';

describe('fixed office constants and startup check', () => {
  it('identifies only the reserved fixed institution and faculty IDs', () => {
    expect(FIXED_OFFICE.institution).toEqual({
      id: 1,
      name: 'Zagazig University',
      institutionType: 'PUBLIC_UNIVERSITY',
    });
    expect(FIXED_OFFICE.faculty).toEqual({
      id: 1,
      institutionId: 1,
      name: 'Faculty of Computer and Information',
    });

    expect(isFixedInstitutionId(1)).toBe(true);
    expect(isFixedInstitutionId(2)).toBe(false);
    expect(isFixedFacultyId(1)).toBe(true);
    expect(isFixedFacultyId(2)).toBe(false);
  });

  it('passes when the fixed institution and faculty match exactly', async () => {
    const prisma = {
      educationalInstitution: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          name: 'Zagazig University',
          institutionType: 'PUBLIC_UNIVERSITY',
        }),
      },
      faculty: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          institutionId: 1,
          name: 'Faculty of Computer and Information',
        }),
      },
    };

    await expect(
      assertFixedOfficeHierarchy(prisma as never),
    ).resolves.toBeUndefined();
  });

  it('throws when the fixed institution is absent or conflicting', async () => {
    const absent = {
      educationalInstitution: { findUnique: jest.fn().mockResolvedValue(null) },
      faculty: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          institutionId: 1,
          name: 'Faculty of Computer and Information',
        }),
      },
    };
    await expect(assertFixedOfficeHierarchy(absent as never)).rejects.toThrow(
      /fixed/i,
    );

    const wrongType = {
      educationalInstitution: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          name: 'Zagazig University',
          institutionType: 'PRIVATE_UNIVERSITY',
        }),
      },
      faculty: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          institutionId: 1,
          name: 'Faculty of Computer and Information',
        }),
      },
    };
    await expect(
      assertFixedOfficeHierarchy(wrongType as never),
    ).rejects.toThrow(/fixed/i);

    const wrongName = {
      educationalInstitution: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          name: 'Other University',
          institutionType: 'PUBLIC_UNIVERSITY',
        }),
      },
      faculty: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          institutionId: 1,
          name: 'Faculty of Computer and Information',
        }),
      },
    };
    await expect(
      assertFixedOfficeHierarchy(wrongName as never),
    ).rejects.toThrow(/fixed/i);
  });

  it('throws when the fixed faculty is absent or conflicting', async () => {
    const validInst = {
      id: 1,
      name: 'Zagazig University',
      institutionType: 'PUBLIC_UNIVERSITY',
    };

    const absent = {
      educationalInstitution: {
        findUnique: jest.fn().mockResolvedValue(validInst),
      },
      faculty: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(assertFixedOfficeHierarchy(absent as never)).rejects.toThrow(
      /fixed/i,
    );

    const wrongParent = {
      educationalInstitution: {
        findUnique: jest.fn().mockResolvedValue(validInst),
      },
      faculty: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          institutionId: 2,
          name: 'Faculty of Computer and Information',
        }),
      },
    };
    await expect(
      assertFixedOfficeHierarchy(wrongParent as never),
    ).rejects.toThrow(/fixed/i);

    const wrongName = {
      educationalInstitution: {
        findUnique: jest.fn().mockResolvedValue(validInst),
      },
      faculty: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          institutionId: 1,
          name: 'Faculty of Science',
        }),
      },
    };
    await expect(
      assertFixedOfficeHierarchy(wrongName as never),
    ).rejects.toThrow(/fixed/i);
  });
});
