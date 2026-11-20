import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';

export const LOGIN_THROTTLER_OPTIONS = Symbol('LOGIN_THROTTLER_OPTIONS');

export interface LoginThrottlerOptions {
  readonly windowMs?: number;
  readonly maxIpAttempts?: number;
  readonly maxUsernameAttempts?: number;
  readonly maxKeys?: number;
}

export type ThrottleDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_IP_ATTEMPTS = 15;
const DEFAULT_MAX_USERNAME_ATTEMPTS = 5;
const DEFAULT_MAX_KEYS = 10_000;

@Injectable()
export class LoginThrottler {
  private readonly windowMs: number;
  private readonly maxIpAttempts: number;
  private readonly maxUsernameAttempts: number;
  private readonly maxKeys: number;
  private readonly ipAttempts = new Map<string, number[]>();
  private readonly usernameAttempts = new Map<string, number[]>();

  constructor(
    @Optional()
    @Inject(LOGIN_THROTTLER_OPTIONS)
    options: LoginThrottlerOptions = {},
  ) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxIpAttempts = options.maxIpAttempts ?? DEFAULT_MAX_IP_ATTEMPTS;
    this.maxUsernameAttempts =
      options.maxUsernameAttempts ?? DEFAULT_MAX_USERNAME_ATTEMPTS;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  check(ip: string, attemptedUsername: string, now: Date): ThrottleDecision {
    const nowMs = now.getTime();
    const cutoff = nowMs - this.windowMs;
    const ipTimestamps = pruneBucket(this.ipAttempts, normalizeIp(ip), cutoff);
    const usernameTimestamps = pruneBucket(
      this.usernameAttempts,
      hashUsernameKey(attemptedUsername),
      cutoff,
    );

    const ipBlocked = ipTimestamps.length >= this.maxIpAttempts;
    const usernameBlocked =
      usernameTimestamps.length >= this.maxUsernameAttempts;
    if (!ipBlocked && !usernameBlocked) {
      return { allowed: true };
    }

    let retryAfterMs = 0;
    if (ipBlocked) {
      retryAfterMs = Math.max(
        retryAfterMs,
        ipTimestamps[0] + this.windowMs - nowMs,
      );
    }
    if (usernameBlocked) {
      retryAfterMs = Math.max(
        retryAfterMs,
        usernameTimestamps[0] + this.windowMs - nowMs,
      );
    }

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  recordFailure(ip: string, attemptedUsername: string, now: Date): void {
    const nowMs = now.getTime();
    const cutoff = nowMs - this.windowMs;
    this.appendAttempt(this.ipAttempts, normalizeIp(ip), nowMs, cutoff);
    this.appendAttempt(
      this.usernameAttempts,
      hashUsernameKey(attemptedUsername),
      nowMs,
      cutoff,
    );
  }

  clearUsername(attemptedUsername: string): void {
    this.usernameAttempts.delete(hashUsernameKey(attemptedUsername));
  }

  sweep(now: Date): void {
    const cutoff = now.getTime() - this.windowMs;
    sweepMap(this.ipAttempts, cutoff);
    sweepMap(this.usernameAttempts, cutoff);
  }

  private appendAttempt(
    map: Map<string, number[]>,
    key: string,
    nowMs: number,
    cutoff: number,
  ): void {
    const existing = pruneBucket(map, key, cutoff);
    if (existing.length === 0) {
      sweepMap(map, cutoff);
      while (map.size >= this.maxKeys) {
        const oldest = map.keys().next();
        if (oldest.done) {
          break;
        }
        map.delete(oldest.value);
      }
    }
    existing.push(nowMs);
    map.delete(key);
    map.set(key, existing);
  }
}

function normalizeIp(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return 'unknown';
  }
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

function hashUsernameKey(raw: string): string {
  return createHash('sha256')
    .update(raw.trim().toLowerCase(), 'utf8')
    .digest('hex');
}

function pruneBucket(
  map: Map<string, number[]>,
  key: string,
  cutoff: number,
): number[] {
  const timestamps = map.get(key);
  if (!timestamps) {
    return [];
  }
  const active = timestamps.filter((timestamp) => timestamp > cutoff);
  if (active.length === 0) {
    map.delete(key);
    return [];
  }
  if (active.length !== timestamps.length) {
    map.set(key, active);
  }
  return active;
}

function sweepMap(map: Map<string, number[]>, cutoff: number): void {
  for (const key of map.keys()) {
    pruneBucket(map, key, cutoff);
  }
}
