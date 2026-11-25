import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import { createPage, type PageResult } from '../common/http/page';
import type { PageQueryDto } from '../common/http/page-query.dto';
import type {
  HistoryAction,
  HistoryActorKind,
  HistoryRecordType,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ChangeHistoryEntryView } from './change-history';

interface SelectedHistoryRow {
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
}

@Injectable()
export class ChangeHistoryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Returns newest-first paged history for a record, or 404 if neither record nor history exists. */
  async listRecordHistory(
    recordType: HistoryRecordType,
    recordId: number,
    query: Pick<PageQueryDto, 'page' | 'pageSize'>,
    recordExists: (id: number) => Promise<boolean>,
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    const where = { recordType, recordId };
    const { page, pageSize } = query;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.changeHistory.count({ where }),
      this.prisma.changeHistory.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          recordType: true,
          recordId: true,
          action: true,
          actorKind: true,
          operatorAttribution: true,
          occurredAt: true,
          before: true,
          after: true,
          staffUser: {
            select: {
              id: true,
              username: true,
              fullName: true,
            },
          },
        },
      }),
    ]);

    if (total === 0 && !(await recordExists(recordId))) {
      throw new ApiError(
        HttpStatus.NOT_FOUND,
        ERROR_CODES.NOT_FOUND,
        'Record not found',
      );
    }

    return createPage(rows.map(toHistoryEntryView), total, page, pageSize);
  }
}

function toHistoryEntryView(row: SelectedHistoryRow): ChangeHistoryEntryView {
  return {
    id: row.id,
    recordType: row.recordType,
    recordId: row.recordId,
    action: row.action,
    actorKind: row.actorKind,
    staffUser: row.staffUser
      ? {
          id: row.staffUser.id,
          username: row.staffUser.username,
          fullName: row.staffUser.fullName,
        }
      : null,
    operatorAttribution: row.operatorAttribution,
    occurredAt: row.occurredAt.toISOString(),
    before: row.before ?? null,
    after: row.after ?? null,
  };
}
