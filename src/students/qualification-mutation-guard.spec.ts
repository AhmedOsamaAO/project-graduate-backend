import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  DegreeLevel,
  EquivalencyStatus,
  type Prisma,
} from '../generated/prisma/client';
import {
  QualificationMutationGuardRegistry,
  type QualificationMutationContext,
  type QualificationSnapshot,
} from './qualification-mutation-guard';

function makeSnapshot(
  overrides: Partial<QualificationSnapshot> = {},
): QualificationSnapshot {
  return {
    id: 11,
    studentId: 42,
    degreeLevel: DegreeLevel.BACHELOR,
    qualificationName: 'B.Sc. Computer Science',
    institutionId: 1,
    facultyId: 1,
    departmentId: 3,
    graduationYear: 2023,
    overallGrade: 'Very Good',
    equivalencyStatus: EquivalencyStatus.NOT_REQUIRED,
    equivalencyDecisionNumber: null,
    equivalencyDecisionDate: null,
    archivedAt: null,
    version: 1,
    ...overrides,
  };
}

describe('qualification-mutation-guard', () => {
  it('runs registered guards sequentially for UPDATE and ARCHIVE contexts and supports idempotent unregistering', async () => {
    const registry = new QualificationMutationGuardRegistry();
    const calls: string[] = [];
    const fakeTx = {} as Prisma.TransactionClient;

    const unregisterFirst = registry.register({
      name: 'first-guard',
      assertCanMutate(tx, context) {
        expect(tx).toBe(fakeTx);
        calls.push(
          `first:${context.kind}:${context.qualificationId}:${context.studentId}`,
        );
        return Promise.resolve();
      },
    });
    const guardSecond = {
      name: 'second-guard',
      assertCanMutate(
        _tx: Prisma.TransactionClient,
        context: QualificationMutationContext,
      ) {
        calls.push(`second:${context.kind}:${context.qualificationId}`);
        return Promise.resolve();
      },
    };
    registry.register(guardSecond);

    const before = makeSnapshot();
    const updateContext: QualificationMutationContext = {
      kind: 'UPDATE',
      qualificationId: 11,
      studentId: 42,
      before,
      next: makeSnapshot({
        equivalencyStatus: EquivalencyStatus.PENDING,
        version: 2,
      }),
    };

    await registry.assertCanMutate(fakeTx, updateContext);
    expect(calls).toEqual(['first:UPDATE:11:42', 'second:UPDATE:11']);

    // Unregistering twice is a safe no-op and removes only the targeted guard
    unregisterFirst();
    unregisterFirst();
    calls.length = 0;

    const archiveContext: QualificationMutationContext = {
      kind: 'ARCHIVE',
      qualificationId: 11,
      studentId: 42,
      before,
      archivedAt: new Date('2026-11-27T10:00:00.000Z'),
    };
    await registry.assertCanMutate(fakeTx, archiveContext);
    expect(calls).toEqual(['second:ARCHIVE:11']);
  });

  it('rejects duplicate guard registrations with the same name', () => {
    const registry = new QualificationMutationGuardRegistry();
    registry.register({
      name: 'enrollment-eligibility',
      assertCanMutate: () => Promise.resolve(),
    });

    expect(() =>
      registry.register({
        name: 'enrollment-eligibility',
        assertCanMutate: () => Promise.resolve(),
      }),
    ).toThrow(/enrollment-eligibility/);
  });

  it('propagates a guard rejection to abort qualification mutation', async () => {
    const registry = new QualificationMutationGuardRegistry();
    const secondSpy = jest.fn();

    registry.register({
      name: 'enrollment-eligibility',
      assertCanMutate() {
        return Promise.reject(
          new ApiError(
            409,
            ERROR_CODES.RECORD_IN_USE,
            'Qualification is referenced by an enrollment',
          ),
        );
      },
    });
    registry.register({
      name: 'not-reached',
      assertCanMutate: secondSpy,
    });

    const before = makeSnapshot();
    await expect(
      registry.assertCanMutate({} as Prisma.TransactionClient, {
        kind: 'ARCHIVE',
        qualificationId: before.id,
        studentId: before.studentId,
        before,
        archivedAt: new Date('2026-11-27T10:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

    expect(secondSpy).not.toHaveBeenCalled();
  });
});
