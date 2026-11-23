import { ERROR_CODES } from '../common/errors/error-codes';
import { PageQueryDto } from '../common/http/page-query.dto';
import type { PrismaService } from '../prisma/prisma.service';
import { ChangeHistoryService } from './change-history.service';

describe('ChangeHistoryService', () => {
  it('queries newest-first pages and maps entries to safe DTOs', async () => {
    const occurredAt = new Date('2026-11-23T12:00:00.000Z');
    const count = jest.fn().mockResolvedValue(1);
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 7,
        recordType: 'EDUCATIONAL_INSTITUTION',
        recordId: 2,
        action: 'CREATED',
        actorKind: 'STAFF',
        operatorAttribution: null,
        occurredAt,
        before: null,
        after: { id: 2, name: 'Cairo University' },
        staffUser: { id: 3, username: 'staff.one', fullName: 'Staff One' },
        operationCorrelation: 'internal-correlation-secret',
      },
    ]);
    const prisma = {
      changeHistory: { count, findMany },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    } as unknown as PrismaService;

    const service = new ChangeHistoryService(prisma);
    const query = Object.assign(new PageQueryDto(), { page: 2, pageSize: 10 });
    const exists = jest.fn().mockResolvedValue(true);

    const page = await service.listRecordHistory(
      'EDUCATIONAL_INSTITUTION',
      2,
      query,
      exists,
    );

    expect(exists).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { recordType: 'EDUCATIONAL_INSTITUTION', recordId: 2 },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: 10,
        take: 10,
      }),
    );
    expect(page).toEqual({
      items: [
        {
          id: 7,
          recordType: 'EDUCATIONAL_INSTITUTION',
          recordId: 2,
          action: 'CREATED',
          actorKind: 'STAFF',
          staffUser: { id: 3, username: 'staff.one', fullName: 'Staff One' },
          operatorAttribution: null,
          occurredAt: '2026-11-23T12:00:00.000Z',
          before: null,
          after: { id: 2, name: 'Cairo University' },
        },
      ],
      total: 1,
      page: 2,
      pageSize: 10,
    });
    expect(page.items[0]).not.toHaveProperty('operationCorrelation');
  });

  it('returns an empty page when the record exists with zero history rows', async () => {
    const prisma = {
      changeHistory: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    } as unknown as PrismaService;

    const service = new ChangeHistoryService(prisma);
    const query = new PageQueryDto();
    const exists = jest.fn().mockResolvedValue(true);

    const page = await service.listRecordHistory('FACULTY', 1, query, exists);
    expect(exists).toHaveBeenCalledWith(1);
    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('throws NOT_FOUND when total is zero and the record does not exist', async () => {
    const prisma = {
      changeHistory: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    } as unknown as PrismaService;

    const service = new ChangeHistoryService(prisma);
    const query = new PageQueryDto();

    await expect(
      service.listRecordHistory('DEPARTMENT', 999, query, () =>
        Promise.resolve(false),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });
});
