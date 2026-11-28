import { Injectable } from '@nestjs/common';
import type {
  DegreeLevel,
  EquivalencyStatus,
  Prisma,
} from '../generated/prisma/client';

export interface QualificationSnapshot {
  readonly id: number;
  readonly studentId: number;
  readonly degreeLevel: DegreeLevel;
  readonly qualificationName: string | null;
  readonly institutionId: number | null;
  readonly facultyId: number | null;
  readonly departmentId: number | null;
  readonly graduationYear: number | null;
  readonly overallGrade: string | null;
  readonly equivalencyStatus: EquivalencyStatus;
  readonly equivalencyDecisionNumber: string | null;
  readonly equivalencyDecisionDate: Date | null;
  readonly archivedAt: Date | null;
  readonly version: number;
}

export interface QualificationUpdateContext {
  readonly kind: 'UPDATE';
  readonly qualificationId: number;
  readonly studentId: number;
  readonly before: QualificationSnapshot;
  readonly next: QualificationSnapshot;
}

export interface QualificationArchiveContext {
  readonly kind: 'ARCHIVE';
  readonly qualificationId: number;
  readonly studentId: number;
  readonly before: QualificationSnapshot;
  readonly archivedAt: Date;
}

export type QualificationMutationContext =
  QualificationUpdateContext | QualificationArchiveContext;

/**
 * Transaction-scoped guard contract registered by dependent modules
 * (for example, enrollment eligibility protection) to block archiving or
 * correcting a qualification without creating cyclic Nest provider dependencies.
 */
export interface QualificationMutationGuard {
  readonly name: string;
  assertCanMutate(
    tx: Prisma.TransactionClient,
    context: QualificationMutationContext,
  ): Promise<void>;
}

@Injectable()
export class QualificationMutationGuardRegistry {
  private readonly guards = new Map<string, QualificationMutationGuard>();

  register(guard: QualificationMutationGuard): () => void {
    if (this.guards.has(guard.name)) {
      throw new Error(
        `Qualification mutation guard "${guard.name}" is already registered`,
      );
    }

    this.guards.set(guard.name, guard);
    return () => {
      if (this.guards.get(guard.name) === guard) {
        this.guards.delete(guard.name);
      }
    };
  }

  async assertCanMutate(
    tx: Prisma.TransactionClient,
    context: QualificationMutationContext,
  ): Promise<void> {
    for (const guard of this.guards.values()) {
      await guard.assertCanMutate(tx, context);
    }
  }
}
