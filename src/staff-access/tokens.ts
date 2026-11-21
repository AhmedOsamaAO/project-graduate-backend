import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Generates at least 32 random bytes encoded as URL-safe base64. */
export function generateRandomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Computes the lowercase 64-character SHA-256 hex digest of a token. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Generates at least 32 random bytes for the opaque cookie credential and its SHA-256 hex digest. */
export function generateSessionCredential(): {
  readonly raw: string;
  readonly digest: string;
} {
  const raw = generateRandomToken();
  return { raw, digest: sha256Hex(raw) };
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
