import { Prisma } from '../generated/prisma/client';
import type { HistoryAction, StaffUser } from '../generated/prisma/client';

export interface OperatorActor {
  readonly attribution: string;
}

export interface StaffActor {
  readonly staffUserId: number;
}

export type StaffAccountSnapshotSource = Pick<
  StaffUser,
  | 'id'
  | 'username'
  | 'fullName'
  | 'deactivatedAt'
  | 'version'
  | 'createdAt'
  | 'updatedAt'
>;

/** Explicit allowlist used both for command results and account history. */
export function staffAccountView(staff: StaffAccountSnapshotSource) {
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

function toHistorySnapshot(staff: StaffUser | null) {
  return staff === null ? Prisma.DbNull : staffAccountView(staff);
}

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
      before: toHistorySnapshot(before),
      after: staffAccountView(after),
    },
  });
}

/** Appends a staff-attributed account event inside the owning transaction. */
export async function appendStaffAccountHistory(
  tx: Prisma.TransactionClient,
  actor: StaffActor,
  action: 'SIGN_IN' | 'PASSWORD_CHANGED',
  before: StaffUser | null,
  after: StaffUser,
): Promise<void> {
  await tx.changeHistory.create({
    data: {
      recordType: 'STAFF_USER',
      recordId: after.id,
      action,
      actorKind: 'STAFF',
      staffUserId: actor.staffUserId,
      before: toHistorySnapshot(before),
      after: staffAccountView(after),
    },
  });
}

/** Appends an unauthenticated sign-in failure without raw input or secrets. */
export async function appendFailedSignInHistory(
  tx: Prisma.TransactionClient,
  recordId: number | null,
): Promise<void> {
  await tx.changeHistory.create({
    data: {
      recordType: 'STAFF_USER',
      recordId,
      action: 'SIGN_IN_FAILED',
      actorKind: 'UNAUTHENTICATED',
      before: Prisma.DbNull,
      after: Prisma.DbNull,
    },
  });
}
