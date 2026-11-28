import {
  AcademicRank,
  SupervisorAffiliation,
  type Prisma,
} from '../generated/prisma/client';
import {
  SupervisorCorrectionGuardRegistry,
  type SupervisorCorrectionContext,
  type SupervisorSnapshot,
} from './supervisor-correction-guard';

describe('SupervisorCorrectionGuardRegistry', () => {
  const baseSnapshot: SupervisorSnapshot = {
    id: 5,
    fullName: 'Dr. Omnia Hassan',
    academicRank: AcademicRank.PROFESSOR,
    affiliation: SupervisorAffiliation.INTERNAL,
    departmentId: 2,
    workplace: null,
    phone: null,
    email: null,
    nationalId: null,
    externalApprovalStatus: null,
    externalRejectionReason: null,
    deactivatedAt: null,
    version: 1,
  };

  const sampleContext: SupervisorCorrectionContext = {
    supervisorId: 5,
    before: baseSnapshot,
    next: {
      ...baseSnapshot,
      academicRank: AcademicRank.LECTURER,
      version: 2,
    },
  };

  it('registers, invokes, and unregisters guards while rejecting duplicate names', async () => {
    const registry = new SupervisorCorrectionGuardRegistry();
    const seenIds: number[] = [];

    const unregister = registry.register({
      name: 'thesis-main-rank-guard',
      assertCanCorrect: (_tx, ctx) => {
        seenIds.push(ctx.supervisorId);
        return Promise.resolve();
      },
    });

    expect(() =>
      registry.register({
        name: 'thesis-main-rank-guard',
        assertCanCorrect: () => Promise.resolve(),
      }),
    ).toThrow(/already registered/);

    await registry.assertCanCorrect(
      {} as Prisma.TransactionClient,
      sampleContext,
    );
    expect(seenIds).toEqual([5]);

    unregister();
    registry.register({
      name: 'thesis-main-rank-guard',
      assertCanCorrect: () => Promise.reject(new Error('replacement stays')),
    });
    // Stale unregister from earlier guard must not remove replacement
    unregister();

    await expect(
      registry.assertCanCorrect({} as Prisma.TransactionClient, sampleContext),
    ).rejects.toThrow('replacement stays');
  });
});
