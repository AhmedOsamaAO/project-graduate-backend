import { Inject, Injectable, Optional } from '@nestjs/common';
import { PRE_LOGIN_CSRF_TTL_MS } from './cookies';
import {
  generateCsrfToken,
  hashSessionCredential,
  timingSafeTokenEqual,
} from './passwords';

export const PRE_LOGIN_CSRF_OPTIONS = Symbol('PRE_LOGIN_CSRF_OPTIONS');

export interface PreLoginCsrfOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

interface PreLoginCsrfEntry {
  readonly csrfToken: string;
  readonly expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;

@Injectable()
export class PreLoginCsrfStore {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, PreLoginCsrfEntry>();

  constructor(
    @Optional()
    @Inject(PRE_LOGIN_CSRF_OPTIONS)
    options: PreLoginCsrfOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? PRE_LOGIN_CSRF_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  issue(now: Date): {
    readonly cookieValue: string;
    readonly csrfToken: string;
  } {
    this.sweep(now);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }

    const cookieValue = generateCsrfToken();
    const csrfToken = generateCsrfToken();
    this.entries.set(hashSessionCredential(cookieValue), {
      csrfToken,
      expiresAt: now.getTime() + this.ttlMs,
    });
    return { cookieValue, csrfToken };
  }

  verify(
    cookieValue: string | undefined,
    headerToken: string | undefined,
    now: Date,
  ): boolean {
    if (
      !cookieValue ||
      !headerToken ||
      cookieValue.length > 512 ||
      headerToken.length > 512
    ) {
      return false;
    }

    const key = hashSessionCredential(cookieValue);
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }

    if (now.getTime() >= entry.expiresAt) {
      this.entries.delete(key);
      return false;
    }

    return timingSafeTokenEqual(entry.csrfToken, headerToken);
  }

  consume(cookieValue: string | undefined): void {
    if (!cookieValue || cookieValue.length > 512) {
      return;
    }
    this.entries.delete(hashSessionCredential(cookieValue));
  }

  sweep(now: Date): void {
    const timestamp = now.getTime();
    for (const [key, entry] of this.entries) {
      if (timestamp >= entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }
}
