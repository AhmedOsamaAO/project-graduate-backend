import { ERROR_CODES } from '../common/errors/error-codes';
import type {
  HistoryAction,
  HistoryActorKind,
  HistoryRecordType,
} from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ChangeHistoryService } from './change-history.service';

interface StoredHistoryRow {
  readonly id: number;
  readonly recordType: HistoryRecordType;
  readonly recordId: number | null;
  readonly action: HistoryAction;
  readonly actorKind: HistoryActorKind;
  readonly operatorAttribution: string | null;
  readonly occurredAt: Date;
  readonly before: unknown;
  readonly after: unknown;
  readonly staffUser: {
    readonly id: number;
    readonly username: string;
    readonly fullName: string;
  } | null;
  readonly operationCorrelation: string | null;
}

function createFakeHistoryPrisma(rows: readonly StoredHistoryRow[]) {
  const filterRows = (where?: {
    recordType?: HistoryRecordType;
    recordId?: number;
  }) =>
    rows.filter(
      (row) =>
        (where?.recordType === undefined ||
          row.recordType === where.recordType) &&
        (where?.recordId === undefined || row.recordId === where.recordId),
    );

  return {
    changeHistory: {
      count: ({
        where,
      }: {
        where?: { recordType?: HistoryRecordType; recordId?: number };
      }) => Promise.resolve(filterRows(where).length),
      findMany: ({
        where,
        skip = 0,
        take = 20,
      }: {
        where?: { recordType?: HistoryRecordType; recordId?: number };
        skip?: number;
        take?: number;
      }) => {
        const sorted = [...filterRows(where)].sort((left, right) => {
          const timeDiff =
            right.occurredAt.getTime() - left.occurredAt.getTime();
          return timeDiff !== 0 ? timeDiff : right.id - left.id;
        });
        const sliced = sorted.slice(skip, skip + take).map((row) => ({
          id: row.id,
          recordType: row.recordType,
          recordId: row.recordId,
          action: row.action,
          actorKind: row.actorKind,
          operatorAttribution: row.operatorAttribution,
          occurredAt: row.occurredAt,
          before: row.before,
          after: row.after,
          staffUser: row.staffUser,
        }));
        return Promise.resolve(sliced);
      },
    },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  } as unknown as PrismaService;
}

describe('ChangeHistoryService', () => {
  it('returns newest-first pages with safe actor DTOs and excludes internal correlation fields', async () => {
    const t1 = new Date('2026-11-23T10:00:00.000Z');
    const t2 = new Date('2026-11-23T12:00:00.000Z');
    const staffUser = { id: 3, username: 'staff.one', fullName: 'Staff One' };
    const service = new ChangeHistoryService(
      createFakeHistoryPrisma([
        {
          id: 5,
          recordType: 'EDUCATIONAL_INSTITUTION',
          recordId: 2,
          action: 'CREATED',
          actorKind: 'STAFF',
          operatorAttribution: null,
          occurredAt: t1,
          before: null,
          after: { id: 2, name: 'Cairo University' },
          staffUser,
          operationCorrelation: 'internal-corr-1',
        },
        {
          id: 7,
          recordType: 'EDUCATIONAL_INSTITUTION',
          recordId: 2,
          action: 'UPDATED',
          actorKind: 'STAFF',
          operatorAttribution: null,
          occurredAt: t2,
          before: { id: 2, name: 'Cairo University' },
          after: { id: 2, name: 'Cairo University Updated' },
          staffUser,
          operationCorrelation: 'internal-corr-2',
        },
        {
          id: 9,
          recordType: 'EDUCATIONAL_INSTITUTION',
          recordId: 2,
          action: 'DELETED',
          actorKind: 'STAFF',
          operatorAttribution: null,
          occurredAt: t2,
          before: { id: 2, name: 'Cairo University Updated' },
          after: null,
          staffUser,
          operationCorrelation: 'internal-corr-3',
        },
        {
          id: 10,
          recordType: 'FACULTY',
          recordId: 2,
          action: 'CREATED',
          actorKind: 'STAFF',
          operatorAttribution: null,
          occurredAt: t2,
          before: null,
          after: { id: 2, name: 'Other Record' },
          staffUser,
          operationCorrelation: null,
        },
      ]),
    );

    const page1 = await service.listRecordHistory(
      'EDUCATIONAL_INSTITUTION',
      2,
      { page: 1, pageSize: 2 },
      () => Promise.resolve(true),
    );
    expect(page1).toEqual({
      items: [
        {
          id: 9,
          recordType: 'EDUCATIONAL_INSTITUTION',
          recordId: 2,
          action: 'DELETED',
          actorKind: 'STAFF',
          staffUser: { id: 3, username: 'staff.one', fullName: 'Staff One' },
          operatorAttribution: null,
          occurredAt: '2026-11-23T12:00:00.000Z',
          before: { id: 2, name: 'Cairo University Updated' },
          after: null,
        },
        {
          id: 7,
          recordType: 'EDUCATIONAL_INSTITUTION',
          recordId: 2,
          action: 'UPDATED',
          actorKind: 'STAFF',
          staffUser: { id: 3, username: 'staff.one', fullName: 'Staff One' },
          operatorAttribution: null,
          occurredAt: '2026-11-23T12:00:00.000Z',
          before: { id: 2, name: 'Cairo University' },
          after: { id: 2, name: 'Cairo University Updated' },
        },
      ],
      total: 3,
      page: 1,
      pageSize: 2,
    });
    expect(page1.items[0]).not.toHaveProperty('operationCorrelation');

    const page2 = await service.listRecordHistory(
      'EDUCATIONAL_INSTITUTION',
      2,
      { page: 2, pageSize: 2 },
      () => Promise.resolve(false),
    );
    expect(page2.items.map((item) => item.id)).toEqual([5]);
    expect(page2.total).toBe(3);
  });

  it('returns an empty page when the record exists with zero history rows', async () => {
    const service = new ChangeHistoryService(createFakeHistoryPrisma([]));

    const page = await service.listRecordHistory(
      'FACULTY',
      1,
      { page: 1, pageSize: 20 },
      () => Promise.resolve(true),
    );
    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('throws NOT_FOUND when total is zero and the record does not exist', async () => {
    const service = new ChangeHistoryService(createFakeHistoryPrisma([]));

    await expect(
      service.listRecordHistory(
        'DEPARTMENT',
        999,
        { page: 1, pageSize: 20 },
        () => Promise.resolve(false),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });
});
