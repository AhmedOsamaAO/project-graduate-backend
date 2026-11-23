import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { Prisma } from '../generated/prisma/client';
import { isRetryableTransactionError } from './prisma-errors';

export interface TransactionHost {
  $transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { isolationLevel: 'Serializable' },
  ): Promise<T>;
}

/** Callbacks contain database work only; hashing and external effects stay outside. */
export class TransactionRunner {
  constructor(private readonly database: TransactionHost) {}

  async run<I, T>(
    input: I,
    work: (tx: Prisma.TransactionClient, input: I) => Promise<T>,
  ): Promise<T> {
    const snapshot = structuredClone(input);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.database.$transaction(
          (tx) => work(tx, structuredClone(snapshot)),
          { isolationLevel: 'Serializable' },
        );
      } catch (error) {
        if (!isRetryableTransactionError(error)) throw error;
        if (attempt === 3) {
          throw new ApiError(
            HttpStatus.CONFLICT,
            ERROR_CODES.RETRYABLE_CONFLICT,
            'Concurrent changes prevented this operation; retry with the original version',
          );
        }
      }
    }
  }
}
