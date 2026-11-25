import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reserved identifiers and canonical attributes for the single operating office.
 * Must stay synchronized with migration `20261123120100_provision_fixed_office`.
 */
export const FIXED_OFFICE = {
  institution: {
    id: 1,
    name: 'Zagazig University',
    institutionType: 'PUBLIC_UNIVERSITY',
  },
  faculty: {
    id: 1,
    institutionId: 1,
    name: 'Faculty of Computer and Information',
  },
} as const;

export function isFixedInstitutionId(id: number): boolean {
  return id === FIXED_OFFICE.institution.id;
}

export function isFixedFacultyId(id: number): boolean {
  return id === FIXED_OFFICE.faculty.id;
}

@Injectable()
export class FixedOfficeStartupCheck implements OnModuleInit {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await assertFixedOfficeHierarchy(this.prisma);
  }
}

/** Refuses application startup when the fixed operating hierarchy is missing or altered. */
export async function assertFixedOfficeHierarchy(
  prisma: Pick<PrismaClient, 'educationalInstitution' | 'faculty'>,
): Promise<void> {
  const [institution, faculty] = await Promise.all([
    prisma.educationalInstitution.findUnique({
      where: { id: FIXED_OFFICE.institution.id },
      select: { id: true, name: true, institutionType: true },
    }),
    prisma.faculty.findUnique({
      where: { id: FIXED_OFFICE.faculty.id },
      select: { id: true, institutionId: true, name: true },
    }),
  ]);

  if (
    !institution ||
    institution.name !== FIXED_OFFICE.institution.name ||
    institution.institutionType !== FIXED_OFFICE.institution.institutionType
  ) {
    throw new Error(
      'Fixed operating institution is absent or conflicts with expected Zagazig University record',
    );
  }

  if (
    !faculty ||
    faculty.institutionId !== FIXED_OFFICE.faculty.institutionId ||
    faculty.name !== FIXED_OFFICE.faculty.name
  ) {
    throw new Error(
      'Fixed operating faculty is absent or conflicts with expected Faculty of Computer and Information record',
    );
  }
}
