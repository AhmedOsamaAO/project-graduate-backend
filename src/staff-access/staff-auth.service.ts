import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  appendFailedSignInHistory,
  appendStaffAccountHistory,
  staffAccountView,
  type StaffAccountView,
} from '../change-history/change-history';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.module';
import type { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionRunner } from '../prisma/transaction-runner';
import { LoginThrottler } from './login-throttler';
import {
  generateCsrfToken,
  generateSessionCredential,
  hashPassword,
  hashSessionCredential,
  tryCanonicalUsername,
  validatePasswordPolicy,
  verifyDummyPassword,
  verifyPassword,
} from './passwords';

export const STAFF_AUTH_CLOCK = Symbol('STAFF_AUTH_CLOCK');
export const STAFF_AUTH_PASSWORD_VERIFIER = Symbol(
  'STAFF_AUTH_PASSWORD_VERIFIER',
);

export interface Clock {
  now(): Date;
}

export type PasswordVerifier = (
  passwordHash: string,
  plain: string,
) => Promise<boolean>;

export interface AuthenticatedSession {
  readonly sessionId: number;
  readonly authVersion: number;
  readonly csrfToken: string;
  readonly user: StaffAccountView;
}

export interface LoginResult {
  readonly user: StaffAccountView;
  readonly rawSessionCredential: string;
  readonly csrfToken: string;
}

export interface LoginInput {
  readonly username: string;
  readonly password: string;
  readonly clientIp: string;
  readonly previousSessionRaw?: string;
}

export interface ChangePasswordInput {
  readonly expectedVersion: number;
  readonly currentPassword: string;
  readonly newPassword: string;
}

interface SessionRow {
  readonly sessionId: number;
  readonly authVersion: number;
  readonly csrfToken: string;
  readonly userId: number;
  readonly username: string;
  readonly fullName: string;
  readonly deactivatedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const INVALID_CREDENTIALS_MESSAGE = 'Invalid username or password';

@Injectable()
export class StaffAuthService {
  private readonly transactions: TransactionRunner;
  private readonly clock: Clock;
  private readonly verifyFn: PasswordVerifier;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly throttler: LoginThrottler,
    @Optional() @Inject(STAFF_AUTH_CLOCK) clock?: Clock,
    @Optional()
    @Inject(STAFF_AUTH_PASSWORD_VERIFIER)
    verifyFn?: PasswordVerifier,
  ) {
    this.transactions = new TransactionRunner(prisma);
    this.clock = clock ?? { now: () => new Date() };
    this.verifyFn = verifyFn ?? verifyPassword;
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const check = this.throttler.check(
      input.clientIp,
      input.username,
      this.clock.now(),
    );
    if (!check.allowed) {
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        ERROR_CODES.RATE_LIMITED,
        'Too many sign-in attempts; try again later',
        undefined,
        { 'Retry-After': String(check.retryAfterSeconds) },
      );
    }

    const canonical = tryCanonicalUsername(input.username);
    const candidate = canonical
      ? await this.prisma.staffUser.findUnique({
          where: { username: canonical },
        })
      : null;

    let valid = false;
    if (candidate) {
      valid = await this.verifyFn(candidate.passwordHash, input.password);
    } else {
      await verifyDummyPassword(input.password);
    }

    if (!candidate || candidate.deactivatedAt !== null || !valid) {
      this.throttler.recordFailure(
        input.clientIp,
        input.username,
        this.clock.now(),
      );
      await this.transactions.run(
        { recordId: candidate?.id ?? null },
        async (tx, data) => appendFailedSignInHistory(tx, data.recordId),
      );
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        ERROR_CODES.UNAUTHENTICATED,
        INVALID_CREDENTIALS_MESSAGE,
      );
    }

    const { raw: rawSessionCredential, digest: credentialDigest } =
      generateSessionCredential();
    const csrfToken = generateCsrfToken();
    const previousDigest = input.previousSessionRaw
      ? hashSessionCredential(input.previousSessionRaw)
      : null;

    const outcome = await this.transactions.run(
      {
        staffUserId: candidate.id,
        verifiedAuthVersion: candidate.authVersion,
        credentialDigest,
        csrfToken,
        previousDigest,
      },
      async (tx, data) => {
        await tx.$queryRaw`SELECT id FROM staff_user WHERE id = ${data.staffUserId} FOR UPDATE`;
        const current = await tx.staffUser.findUnique({
          where: { id: data.staffUserId },
        });
        if (
          !current ||
          current.deactivatedAt !== null ||
          current.authVersion !== data.verifiedAuthVersion
        ) {
          await appendFailedSignInHistory(tx, current?.id ?? data.staffUserId);
          return { ok: false as const };
        }

        const issuedAt = this.clock.now();
        const absoluteExpiresAt = new Date(
          issuedAt.getTime() + this.config.sessionAbsoluteTimeoutDays * DAY_MS,
        );
        if (data.previousDigest) {
          await tx.staffSession.deleteMany({
            where: { credentialDigest: data.previousDigest },
          });
        }

        await tx.staffSession.create({
          data: {
            staffUserId: current.id,
            credentialDigest: data.credentialDigest,
            authVersion: current.authVersion,
            csrfSecret: data.csrfToken,
            createdAt: issuedAt,
            lastSeenAt: issuedAt,
            absoluteExpiresAt,
          },
        });
        await appendStaffAccountHistory(
          tx,
          { staffUserId: current.id },
          'SIGN_IN',
          null,
          current,
        );
        return { ok: true as const, user: staffAccountView(current) };
      },
    );

    if (!outcome.ok) {
      this.throttler.recordFailure(
        input.clientIp,
        input.username,
        this.clock.now(),
      );
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        ERROR_CODES.UNAUTHENTICATED,
        INVALID_CREDENTIALS_MESSAGE,
      );
    }

    this.throttler.clearUsername(input.username);
    return {
      user: outcome.user,
      rawSessionCredential,
      csrfToken,
    };
  }

  async resolveSession(
    rawCredential: string | undefined,
    options: { readonly touch?: boolean } = {},
  ): Promise<AuthenticatedSession | null> {
    if (!rawCredential || rawCredential.length > 512) {
      return null;
    }

    const digest = hashSessionCredential(rawCredential);
    const now = this.clock.now();
    const idleCutoff = new Date(
      now.getTime() - this.config.sessionIdleTimeoutMinutes * 60_000,
    );

    if (options.touch === false) {
      const rows = await this.prisma.$queryRaw<SessionRow[]>`
        SELECT
          s.id AS "sessionId",
          s.auth_version AS "authVersion",
          s.csrf_secret AS "csrfToken",
          u.id AS "userId",
          u.username AS "username",
          u.full_name AS "fullName",
          u.deactivated_at AS "deactivatedAt",
          u.version AS "version",
          u.created_at AS "createdAt",
          u.updated_at AS "updatedAt"
        FROM staff_session AS s
        JOIN staff_user AS u ON u.id = s.staff_user_id
        WHERE s.credential_digest = ${digest}
          AND u.deactivated_at IS NULL
          AND u.auth_version = s.auth_version
          AND s.absolute_expires_at > ${now}
          AND s.last_seen_at > ${idleCutoff}
      `;
      return rows.length === 1 ? toAuthenticatedSession(rows[0]) : null;
    }

    const rows = await this.prisma.$queryRaw<SessionRow[]>`
      UPDATE staff_session AS s
      SET last_seen_at = GREATEST(s.last_seen_at, ${now})
      FROM staff_user AS u
      WHERE s.credential_digest = ${digest}
        AND u.id = s.staff_user_id
        AND u.deactivated_at IS NULL
        AND u.auth_version = s.auth_version
        AND s.absolute_expires_at > ${now}
        AND s.last_seen_at > ${idleCutoff}
      RETURNING
        s.id AS "sessionId",
        s.auth_version AS "authVersion",
        s.csrf_secret AS "csrfToken",
        u.id AS "userId",
        u.username AS "username",
        u.full_name AS "fullName",
        u.deactivated_at AS "deactivatedAt",
        u.version AS "version",
        u.created_at AS "createdAt",
        u.updated_at AS "updatedAt"
    `;

    if (rows.length === 0) {
      await this.prisma.$executeRaw`
        DELETE FROM staff_session
        WHERE credential_digest = ${digest}
          AND (
            absolute_expires_at <= ${now}
            OR last_seen_at <= ${idleCutoff}
            OR EXISTS (
              SELECT 1
              FROM staff_user u
              WHERE u.id = staff_session.staff_user_id
                AND (u.deactivated_at IS NOT NULL OR u.auth_version <> staff_session.auth_version)
            )
          )
      `;
      return null;
    }

    return toAuthenticatedSession(rows[0]);
  }

  async logout(session: AuthenticatedSession): Promise<void> {
    await this.prisma.staffSession.deleteMany({
      where: {
        id: session.sessionId,
        staffUserId: session.user.id,
      },
    });
  }

  async changePassword(
    session: AuthenticatedSession,
    input: ChangePasswordInput,
  ): Promise<StaffAccountView> {
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        ERROR_CODES.VALIDATION_ERROR,
        'expectedVersion must be a positive integer',
      );
    }

    const policyError = validatePasswordPolicy(input.newPassword);
    if (policyError !== null) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        ERROR_CODES.VALIDATION_ERROR,
        policyError,
      );
    }

    const user = await this.prisma.staffUser.findUnique({
      where: { id: session.user.id },
    });
    if (
      !user ||
      user.deactivatedAt !== null ||
      user.authVersion !== session.authVersion
    ) {
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        ERROR_CODES.UNAUTHENTICATED,
        'Authentication required',
      );
    }

    const valid = await this.verifyFn(user.passwordHash, input.currentPassword);
    if (!valid) {
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        ERROR_CODES.UNAUTHENTICATED,
        'Invalid credentials',
      );
    }

    const newPasswordHash = await hashPassword(input.newPassword);

    return this.transactions.run(
      {
        staffUserId: session.user.id,
        verifiedAuthVersion: session.authVersion,
        expectedVersion: input.expectedVersion,
        newPasswordHash,
      },
      async (tx, data) => {
        await tx.$queryRaw`SELECT id FROM staff_user WHERE id = ${data.staffUserId} FOR UPDATE`;
        const before = await tx.staffUser.findUnique({
          where: { id: data.staffUserId },
        });
        if (
          !before ||
          before.deactivatedAt !== null ||
          before.authVersion !== data.verifiedAuthVersion
        ) {
          throw new ApiError(
            HttpStatus.UNAUTHORIZED,
            ERROR_CODES.UNAUTHENTICATED,
            'Authentication required',
          );
        }
        if (before.version !== data.expectedVersion) {
          throw new ApiError(
            HttpStatus.CONFLICT,
            ERROR_CODES.STALE_VERSION,
            'Staff account has changed',
          );
        }

        const after = await tx.staffUser.update({
          where: { id: before.id },
          data: {
            passwordHash: data.newPasswordHash,
            authVersion: { increment: 1 },
            version: { increment: 1 },
          },
        });
        await tx.staffSession.deleteMany({ where: { staffUserId: after.id } });
        await appendStaffAccountHistory(
          tx,
          { staffUserId: after.id },
          'PASSWORD_CHANGED',
          before,
          after,
        );
        return staffAccountView(after);
      },
    );
  }
}

function toAuthenticatedSession(row: SessionRow): AuthenticatedSession {
  return {
    sessionId: row.sessionId,
    authVersion: row.authVersion,
    csrfToken: row.csrfToken,
    user: staffAccountView({
      id: row.userId,
      username: row.username,
      fullName: row.fullName,
      deactivatedAt: row.deactivatedAt,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  };
}
