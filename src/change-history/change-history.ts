import { Prisma } from '../generated/prisma/client';
import type { HistoryAction, StaffUser } from '../generated/prisma/client';

export interface OperatorActor {
  readonly attribution: string;
}

/** Explicit allowlist used both for command results and account history. */
export function staffAccountView(staff: StaffUser) {
  return {
    id: staff.id,
    username: staff.username,
    fullName: staff.fullName,
    deactivatedAt: staff.deactivatedAt?.toISOString() ?? null,
    version: staff.version,
    createdAt: staff.createdAt.toISOString(),
    updatedAt: staff.updatedAt.toISOString(),
  };
}

export type StaffAccountView = ReturnType<typeof staffAccountView>;

/** No client of its own: appends can only join the owning mutation. */
export async function appendAccountHistory(
  tx: Prisma.TransactionClient,
  actor: OperatorActor,
  action: HistoryAction,
  before: StaffUser | null,
  after: StaffUser,
): Promise<void> {
  await tx.changeHistory.create({
    data: {
      recordType: 'STAFF_USER',
      recordId: after.id,
      action,
      actorKind: 'OPERATOR',
      operatorAttribution: actor.attribution,
      before: before === null ? Prisma.DbNull : staffAccountView(before),
      after: staffAccountView(after),
    },
  });
}
