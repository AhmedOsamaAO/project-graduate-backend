import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';

export const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export const PASSWORD_POLICY_MESSAGE =
  'Password must have at least 12 characters and at most 1024 UTF-8 bytes';

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

let dummyHashPromise: Promise<string> | undefined;

/** Returns a policy validation message when the password fails length/byte limits. */
export function validatePasswordPolicy(password: string): string | null {
  if ([...password].length < 12 || Buffer.byteLength(password) > 1024) {
    return PASSWORD_POLICY_MESSAGE;
  }
  return null;
}

/** Validates policy and hashes a staff password with Argon2id. */
export async function hashPassword(password: string): Promise<string> {
  const policyError = validatePasswordPolicy(password);
  if (policyError !== null) {
    throw new ApiError(
      HttpStatus.BAD_REQUEST,
      ERROR_CODES.VALIDATION_ERROR,
      policyError,
    );
  }
  return hash(password, ARGON2_OPTIONS);
}

/** Verifies a plaintext password against an Argon2id hash without throwing. */
export async function verifyPassword(
  passwordHash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}

/** Runs an Argon2id verification against a dummy hash to equalize unknown-user timing. */
export async function verifyDummyPassword(plain: string): Promise<void> {
  dummyHashPromise ??= hash(randomBytes(32).toString('hex'), ARGON2_OPTIONS);
  let dummyHash: string;
  try {
    dummyHash = await dummyHashPromise;
  } catch (error) {
    dummyHashPromise = undefined;
    throw error;
  }
  await verifyPassword(dummyHash, plain);
}

/** Normalizes a canonical ASCII username or returns null if invalid. */
export function tryCanonicalUsername(value: string): string | null {
  const username = value.trim();
  if (!USERNAME_PATTERN.test(username)) {
    return null;
  }
  return username.toLowerCase();
}

/** Normalizes a canonical ASCII username or throws a 400 validation error. */
export function canonicalUsername(value: string): string {
  const normalized = tryCanonicalUsername(value);
  if (normalized === null) {
    throw new ApiError(
      HttpStatus.BAD_REQUEST,
      ERROR_CODES.VALIDATION_ERROR,
      'Username must contain 1–100 ASCII letters, digits, dots, underscores or hyphens',
    );
  }
  return normalized;
}

/** Generates at least 32 random bytes for the opaque cookie credential and its SHA-256 hex digest. */
export function generateSessionCredential(): {
  readonly raw: string;
  readonly digest: string;
} {
  const raw = randomBytes(32).toString('base64url');
  return { raw, digest: hashSessionCredential(raw) };
}

/** Computes the lowercase 64-character SHA-256 hex digest stored in PostgreSQL. */
export function hashSessionCredential(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Generates independent 32-byte random synchronizer CSRF token material. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison for opaque random tokens via fixed-length SHA-256 digests. */
export function timingSafeTokenEqual(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}
