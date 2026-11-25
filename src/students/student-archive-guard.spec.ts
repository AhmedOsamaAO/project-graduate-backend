import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { Prisma } from '../generated/prisma/client';
import {
  StudentArchiveGuardRegistry,
  assertStudentActiveInTransaction,
} from './student-archive-guard';

describe('student-archive-guard', () => {
  it('runs registered guards sequentially inside the owning transaction and supports unregistering', async () => {
    const registry = new StudentArchiveGuardRegistry();
    const calls: string[] = [];
    const fakeTx = {} as Prisma.TransactionClient;

    const unregisterFirst = registry.register({
      name: 'first-guard',
      assertCanArchive(tx, studentId) {
        expect(tx).toBe(fakeTx);
        calls.push(`first:${studentId}`);
        return Promise.resolve();
      },
    });
    registry.register({
      name: 'second-guard',
      assertCanArchive(_tx, studentId) {
        calls.push(`second:${studentId}`);
        return Promise.resolve();
      },
    });

    await registry.assertCanArchive(fakeTx, 19);
    expect(calls).toEqual(['first:19', 'second:19']);

    unregisterFirst();
    calls.length = 0;
    await registry.assertCanArchive(fakeTx, 20);
    expect(calls).toEqual(['second:20']);
  });

  it('rejects duplicate guard registrations with the same name', () => {
    const registry = new StudentArchiveGuardRegistry();
    registry.register({
      name: 'selected-photo',
      assertCanArchive: () => Promise.resolve(),
    });

    expect(() =>
      registry.register({
        name: 'selected-photo',
        assertCanArchive: () => Promise.resolve(),
      }),
    ).toThrow(/selected-photo/);
  });

  it('propagates a guard rejection to abort student archival', async () => {
    const registry = new StudentArchiveGuardRegistry();
    registry.register({
      name: 'pending-deletion',
      assertCanArchive() {
        return Promise.reject(
          new ApiError(409, ERROR_CODES.CONFLICT, 'Pending deletion active'),
        );
      },
    });

    await expect(
      registry.assertCanArchive({} as Prisma.TransactionClient, 5),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
  });

  describe('assertStudentActiveInTransaction', () => {
    it('locks the student row FOR SHARE and rejects missing or archived students', async () => {
      const queryRaw = jest.fn().mockResolvedValue([]);
      const findUnique = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 9,
          archivedAt: new Date('2026-11-25T10:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          id: 10,
          archivedAt: null,
        });

      const tx = {
        $queryRaw: queryRaw,
        student: { findUnique },
      } as unknown as Prisma.TransactionClient;

      await expect(
        assertStudentActiveInTransaction(tx, 8),
      ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
      await expect(
        assertStudentActiveInTransaction(tx, 9),
      ).rejects.toMatchObject({ code: ERROR_CODES.STUDENT_ARCHIVED });
      await expect(
        assertStudentActiveInTransaction(tx, 10),
      ).resolves.toMatchObject({ id: 10, archivedAt: null });

      expect(queryRaw).toHaveBeenCalledTimes(3);
    });
  });
});
