import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  appendAccountHistory,
  staffAccountView,
} from '../change-history/change-history';
import type {
  OperatorActor,
  StaffAccountView,
} from '../change-history/change-history';
import type { PrismaClient } from '../generated/prisma/client';
import { TransactionRunner } from '../prisma/transaction-runner';
import { canonicalUsername, hashPassword } from './passwords';

interface ProvisionAccount {
  readonly username: string;
  readonly fullName: string;
  readonly password: string;
}

interface VersionedAccount {
  readonly id: number;
  readonly expectedVersion: number;
}

type AccountMutation =
  | { readonly action: 'PASSWORD_RESET'; readonly passwordHash: string }
  | { readonly action: 'ACCOUNT_DEACTIVATED' };

/** Sole operator workflow writer; future HTTP access reuses the same account locks. */
export class StaffAccounts {
  private readonly transactions: TransactionRunner;

  constructor(database: PrismaClient) {
    this.transactions = new TransactionRunner(database);
  }

  async provision(
    actor: OperatorActor,
    input: ProvisionAccount,
  ): Promise<StaffAccountView> {
    actor = validateActor(actor);
    const username = canonicalUsername(input.username);
    const fullName = input.fullName.trim();
    if (!fullName || fullName.length > 200)
      invalid('Full name must contain 1–200 characters');
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.transactions.run(
        { username, fullName, passwordHash },
        async (tx, data) => {
          const staff = await tx.staffUser.create({ data });
          await appendAccountHistory(
            tx,
            actor,
            'ACCOUNT_PROVISIONED',
            null,
            staff,
          );
          return staffAccountView(staff);
        },
      );
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          ERROR_CODES.USERNAME_EXISTS,
          'Username already exists',
        );
      }
      throw error;
    }
  }

  async resetPassword(
    actor: OperatorActor,
    input: VersionedAccount & { readonly password: string },
  ): Promise<StaffAccountView> {
    actor = validateActor(actor);
    validateVersion(input);
    const passwordHash = await hashPassword(input.password);
    return this.mutate(
      actor,
      { id: input.id, expectedVersion: input.expectedVersion },
      { action: 'PASSWORD_RESET', passwordHash },
    );
  }

  async deactivate(
    actor: OperatorActor,
    input: VersionedAccount,
  ): Promise<StaffAccountView> {
    actor = validateActor(actor);
    validateVersion(input);
    return this.mutate(
      actor,
      { id: input.id, expectedVersion: input.expectedVersion },
      { action: 'ACCOUNT_DEACTIVATED' },
    );
  }

  private async mutate(
    actor: OperatorActor,
    input: VersionedAccount,
    mutation: AccountMutation,
  ): Promise<StaffAccountView> {
    return this.transactions.run(input, async (tx, original) => {
      // Login/password-change must take this same lock before their version recheck.
      await tx.$queryRaw`SELECT id FROM staff_user WHERE id = ${original.id} FOR UPDATE`;
      const before = await tx.staffUser.findUnique({
        where: { id: original.id },
      });
      if (!before)
        throw new ApiError(
          HttpStatus.NOT_FOUND,
          ERROR_CODES.NOT_FOUND,
          'Staff account not found',
        );
      if (before.version !== original.expectedVersion) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          ERROR_CODES.STALE_VERSION,
          'Staff account has changed',
        );
      }
      if (before.deactivatedAt) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          ERROR_CODES.ACCOUNT_DEACTIVATED,
          'Staff account is deactivated',
        );
      }
      const after = await tx.staffUser.update({
        where: { id: original.id },
        data: {
          ...(mutation.action === 'PASSWORD_RESET'
            ? { passwordHash: mutation.passwordHash }
            : { deactivatedAt: new Date() }),
          authVersion: { increment: 1 },
          version: { increment: 1 },
        },
      });
      await tx.staffSession.deleteMany({ where: { staffUserId: after.id } });
      await appendAccountHistory(tx, actor, mutation.action, before, after);
      return staffAccountView(after);
    });
  }
}

function validateActor(actor: OperatorActor): OperatorActor {
  const attribution = actor.attribution.trim();
  if (
    !attribution ||
    attribution.length > 200 ||
    [...attribution].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    invalid('Operator attribution must contain 1–200 printable characters');
  return { attribution };
}

function validateVersion(input: VersionedAccount): void {
  if (
    !Number.isSafeInteger(input.id) ||
    input.id < 1 ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    invalid('Account ID and expectedVersion must be positive integers');
  }
}

function invalid(message: string): never {
  throw new ApiError(
    HttpStatus.BAD_REQUEST,
    ERROR_CODES.VALIDATION_ERROR,
    message,
  );
}
