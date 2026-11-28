import { Injectable } from '@nestjs/common';
import type {
  AcademicRank,
  ExternalApprovalStatus,
  Prisma,
  SupervisorAffiliation,
} from '../generated/prisma/client';

export interface SupervisorSnapshot {
  readonly id: number;
  readonly fullName: string;
  readonly academicRank: AcademicRank;
  readonly affiliation: SupervisorAffiliation;
  readonly departmentId: number | null;
  readonly workplace: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly nationalId: string | null;
  readonly externalApprovalStatus: ExternalApprovalStatus | null;
  readonly externalRejectionReason: string | null;
  readonly deactivatedAt: Date | null;
  readonly version: number;
}

export interface SupervisorCorrectionContext {
  readonly supervisorId: number;
  readonly before: SupervisorSnapshot;
  readonly next: SupervisorSnapshot;
}

/**
 * Transaction-scoped guard contract registered by dependent modules
 * (professional academic supervision, thesis supervision teams) so rank or
 * affiliation corrections cannot leave an existing appointment incompatible.
 */
export interface SupervisorCorrectionGuard {
  readonly name: string;
  assertCanCorrect(
    tx: Prisma.TransactionClient,
    context: SupervisorCorrectionContext,
  ): Promise<void>;
}

@Injectable()
export class SupervisorCorrectionGuardRegistry {
  private readonly guards = new Map<string, SupervisorCorrectionGuard>();

  register(guard: SupervisorCorrectionGuard): () => void {
    if (this.guards.has(guard.name)) {
      throw new Error(
        `Supervisor correction guard "${guard.name}" is already registered`,
      );
    }

    this.guards.set(guard.name, guard);
    return () => {
      if (this.guards.get(guard.name) === guard) {
        this.guards.delete(guard.name);
      }
    };
  }

  async assertCanCorrect(
    tx: Prisma.TransactionClient,
    context: SupervisorCorrectionContext,
  ): Promise<void> {
    for (const guard of this.guards.values()) {
      await guard.assertCanCorrect(tx, context);
    }
  }
}
