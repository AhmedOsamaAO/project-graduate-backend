import { ERROR_CODES } from '../common/errors/error-codes';
import { TransactionRunner, type TransactionHost } from './transaction-runner';
import type { Prisma } from '../generated/prisma/client';

describe('serializable transaction runner', () => {
  it('retries a serialization conflict after work ran without changing the submitted version', async () => {
    const versions: number[] = [];
    let attempt = 0;
    const transaction = jest.fn(
      async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        attempt += 1;
        const result = await work({} as Prisma.TransactionClient);
        if (attempt === 1) {
          throw Object.assign(new Error('serialization conflict'), {
            code: 'P2034',
          });
        }
        return result;
      },
    );
    const runner = new TransactionRunner({
      $transaction: transaction as unknown as TransactionHost['$transaction'],
    });

    await expect(
      runner.run({ expectedVersion: 7 }, (_tx, input) => {
        versions.push(input.expectedVersion);
        return Promise.resolve('updated');
      }),
    ).resolves.toBe('updated');
    expect(versions).toEqual([7, 7]);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('isolates the original input snapshot from in-attempt and caller mutations across retries', async () => {
    const submitted = { expectedVersion: 7, nested: { label: 'initial' } };
    const seen: Array<{ expectedVersion: number; label: string }> = [];
    let attempt = 0;
    const transaction = jest.fn(
      async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        attempt += 1;
        const result = await work({} as Prisma.TransactionClient);
        if (attempt === 1) {
          submitted.expectedVersion = 99;
          submitted.nested.label = 'mutated-by-caller';
          throw Object.assign(new Error('serialization conflict'), {
            code: 'P2034',
          });
        }
        return result;
      },
    );
    const runner = new TransactionRunner({
      $transaction: transaction as unknown as TransactionHost['$transaction'],
    });

    await expect(
      runner.run(submitted, (_tx, input) => {
        seen.push({
          expectedVersion: input.expectedVersion,
          label: input.nested.label,
        });
        input.expectedVersion += 1;
        input.nested.label = 'mutated-in-work';
        return Promise.resolve('ok');
      }),
    ).resolves.toBe('ok');

    expect(seen).toEqual([
      { expectedVersion: 7, label: 'initial' },
      { expectedVersion: 7, label: 'initial' },
    ]);
  });

  it('retries a direct DriverAdapterError TransactionWriteConflict without code or meta', async () => {
    const versions: number[] = [];
    let attempt = 0;
    const transaction = jest.fn(
      async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        attempt += 1;
        const result = await work({} as Prisma.TransactionClient);
        if (attempt === 1) {
          throw Object.assign(new Error('Transaction write conflict'), {
            name: 'DriverAdapterError',
            cause: {
              kind: 'TransactionWriteConflict',
              originalCode: '40001',
            },
          });
        }
        return result;
      },
    );
    const runner = new TransactionRunner({
      $transaction: transaction as unknown as TransactionHost['$transaction'],
    });

    await expect(
      runner.run({ expectedVersion: 11 }, (_tx, input) => {
        versions.push(input.expectedVersion);
        return Promise.resolve('committed');
      }),
    ).resolves.toBe('committed');
    expect(versions).toEqual([11, 11]);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['P2034', { code: 'P2034' }],
    ['40001', { code: '40001' }],
    ['40P01', { code: '40P01' }],
    ['nested meta.code 40001', { meta: { code: '40001' } }],
    [
      'nested driverAdapterError originalCode 40P01',
      { meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } },
    ],
    [
      'direct DriverAdapterError 40001',
      {
        name: 'DriverAdapterError',
        cause: { kind: 'TransactionWriteConflict', originalCode: '40001' },
      },
    ],
    [
      'direct DriverAdapterError 40P01',
      {
        name: 'DriverAdapterError',
        cause: { kind: 'TransactionWriteConflict', originalCode: '40P01' },
      },
    ],
  ])('stops after three total attempts for %s', async (_label, failure) => {
    const versions: number[] = [];
    const transaction = jest.fn(
      async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        await work({} as Prisma.TransactionClient);
        throw Object.assign(new Error('database conflict'), failure);
      },
    );
    const runner = new TransactionRunner({ $transaction: transaction });
    await expect(
      runner.run({ expectedVersion: 4 }, (_tx, input) => {
        versions.push(input.expectedVersion);
        return Promise.resolve();
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.RETRYABLE_CONFLICT });
    expect(versions).toEqual([4, 4, 4]);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

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
