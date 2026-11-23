import { ChangeHistoryService } from '../change-history/change-history.service';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { PrismaService } from '../prisma/prisma.service';
import { ReferenceDataService } from './reference-data.service';

describe('ReferenceDataService', () => {
  const actor = { staffUserId: 10 };

  function makePrismaMock() {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      educationalInstitution: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      faculty: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      department: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      changeHistory: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
      },
    };

    const prisma = {
      educationalInstitution: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      faculty: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      department: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      $transaction: jest.fn((arg: unknown) => {
        if (Array.isArray(arg)) {
          return Promise.all(arg);
        }
        return (arg as (client: typeof tx) => Promise<unknown>)(tx);
      }),
    };

    return {
      prisma: prisma as unknown as PrismaService,
      prismaRaw: prisma,
      tx,
    };
  }

  it('verifies fixed office hierarchy during onModuleInit', async () => {
    const { prisma, prismaRaw } = makePrismaMock();
    prismaRaw.educationalInstitution.findUnique.mockResolvedValue({
      id: 1,
      name: 'Zagazig University',
      institutionType: 'PUBLIC_UNIVERSITY',
    });
    prismaRaw.faculty.findUnique.mockResolvedValue({
      id: 1,
      institutionId: 1,
      name: 'Faculty of Computer and Information',
    });

    const service = new ReferenceDataService(
      prisma,
      new ChangeHistoryService(prisma),
    );
    await expect(service.onModuleInit()).resolves.toBeUndefined();

    prismaRaw.faculty.findUnique.mockResolvedValueOnce(null);
    await expect(service.onModuleInit()).rejects.toThrow(/fixed/i);
  });

  it('rejects invalid names, empty updates, and invalid IDs before starting a transaction', async () => {
    const { prisma, prismaRaw } = makePrismaMock();
    const service = new ReferenceDataService(
      prisma,
      new ChangeHistoryService(prisma),
    );

    await expect(
      service.createInstitution(actor, {
        name: '   ',
        institutionType: 'PUBLIC_UNIVERSITY',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    await expect(
      service.createInstitution(actor, {
        name: 'Bad\nName',
        institutionType: 'PUBLIC_UNIVERSITY',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    await expect(
      service.updateInstitution(actor, 2, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    await expect(
      service.updateFaculty(actor, 2, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    await expect(
      service.updateDepartment(actor, 2, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    await expect(service.deleteInstitution(actor, 0, 1)).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
    });

    expect(prismaRaw.$transaction).not.toHaveBeenCalled();
  });

  it('protects fixed institution and fixed faculty from update, reparent, and delete', async () => {
    const { prisma, tx } = makePrismaMock();
    const now = new Date('2026-11-23T12:00:00.000Z');
    tx.educationalInstitution.findUnique.mockResolvedValue({
      id: 1,
      name: 'Zagazig University',
      institutionType: 'PUBLIC_UNIVERSITY',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    tx.faculty.findUnique.mockResolvedValue({
      id: 1,
      institutionId: 1,
      name: 'Faculty of Computer and Information',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    const service = new ReferenceDataService(
      prisma,
      new ChangeHistoryService(prisma),
    );

    await expect(
      service.updateInstitution(actor, 1, {
        expectedVersion: 1,
        name: 'Renamed',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FIXED_RECORD_PROTECTED });

    await expect(service.deleteInstitution(actor, 1, 1)).rejects.toMatchObject({
      code: ERROR_CODES.FIXED_RECORD_PROTECTED,
    });

    await expect(
      service.updateFaculty(actor, 1, {
        expectedVersion: 1,
        institutionId: 2,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FIXED_RECORD_PROTECTED });

    await expect(service.deleteFaculty(actor, 1, 1)).rejects.toMatchObject({
      code: ERROR_CODES.FIXED_RECORD_PROTECTED,
    });

    expect(tx.changeHistory.create).not.toHaveBeenCalled();
  });

  it('uses allowlisted sorting with an id tie-breaker on list queries', async () => {
    const { prisma, prismaRaw } = makePrismaMock();
    prismaRaw.educationalInstitution.count.mockResolvedValue(0);
    prismaRaw.educationalInstitution.findMany.mockResolvedValue([]);
    prismaRaw.faculty.count.mockResolvedValue(0);
    prismaRaw.faculty.findMany.mockResolvedValue([]);
    prismaRaw.department.count.mockResolvedValue(0);
    prismaRaw.department.findMany.mockResolvedValue([]);

    const service = new ReferenceDataService(
      prisma,
      new ChangeHistoryService(prisma),
    );

    await service.listInstitutions({
      page: 1,
      pageSize: 20,
      sortBy: 'institutionType',
      sortOrder: 'desc',
      search: '  Cairo  ',
    });
    expect(prismaRaw.educationalInstitution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: { contains: 'Cairo', mode: 'insensitive' } },
        orderBy: [{ institutionType: 'desc' }, { id: 'asc' }],
      }),
    );

    await service.listDepartments({
      page: 1,
      pageSize: 20,
      institutionId: 1,
      facultyId: 1,
      sortBy: 'id',
      sortOrder: 'desc',
    });
    expect(prismaRaw.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { facultyId: 1, faculty: { institutionId: 1 } },
        orderBy: [{ id: 'desc' }],
      }),
    );
  });

  it('maps driver adapter unique and foreign-key errors to domain conflicts', async () => {
    const { prisma, prismaRaw, tx } = makePrismaMock();
    const now = new Date('2026-11-23T12:00:00.000Z');
    tx.educationalInstitution.findUnique.mockResolvedValue({
      id: 2,
      name: 'Cairo University',
      institutionType: 'PUBLIC_UNIVERSITY',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    tx.faculty.create.mockRejectedValue({
      meta: { driverAdapterError: { cause: { originalCode: '23505' } } },
    });
    tx.educationalInstitution.delete.mockRejectedValue({
      cause: { originalCode: '23503' },
    });

    const service = new ReferenceDataService(
      prisma,
      new ChangeHistoryService(prisma),
    );

    await expect(
      service.createFaculty(actor, {
        institutionId: 2,
        name: 'Engineering',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FACULTY_NAME_EXISTS });

    await expect(service.deleteInstitution(actor, 2, 1)).rejects.toMatchObject({
      code: ERROR_CODES.RECORD_IN_USE,
    });
    expect(prismaRaw.$transaction).toHaveBeenCalledTimes(2);
  });
});
