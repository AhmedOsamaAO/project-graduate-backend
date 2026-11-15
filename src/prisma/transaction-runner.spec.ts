import { TransactionRunner } from './transaction-runner';
import type { Prisma } from '../generated/prisma/client';

describe('serializable transaction runner', () => {
  it('retries a serialization conflict without changing the submitted version', async () => {
    const versions: number[] = [];
    const transaction = jest
      .fn()
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementation(async (work: () => Promise<unknown>) => work());
    const runner = new TransactionRunner({ $transaction: transaction });

    await expect(
      runner.run({ expectedVersion: 7 }, (_tx, input) => {
        versions.push(input.expectedVersion);
        return Promise.resolve('updated');
      }),
    ).resolves.toBe('updated');
    expect(versions).toEqual([7]);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it.each(['P2034', '40001', '40P01'])(
    'stops after three total attempts for %s',
    async (code) => {
      const versions: number[] = [];
      const transaction = jest.fn(
        async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          await work({} as Prisma.TransactionClient);
          throw Object.assign(new Error('database conflict'), { code });
        },
      );
      const runner = new TransactionRunner({ $transaction: transaction });
      await expect(
        runner.run({ expectedVersion: 4 }, (_tx, input) => {
          versions.push(input.expectedVersion);
          return Promise.resolve();
        }),
      ).rejects.toMatchObject({ code: 'RETRYABLE_CONFLICT' });
      expect(versions).toEqual([4, 4, 4]);
      expect(transaction).toHaveBeenCalledTimes(3);
    },
  );

  it('does not retry validation, stale versions or unknown database failures', async () => {
    const failure = new Error('not retryable');
    const transaction = jest.fn().mockRejectedValue(failure);
    await expect(
      new TransactionRunner({ $transaction: transaction }).run(
        {},
        async () => {},
      ),
    ).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
