import { Injectable } from '@nestjs/common';
import { PRE_LOGIN_CSRF_TTL_MS } from './cookies';
import { generateRandomToken, sha256Hex, timingSafeTokenEqual } from './tokens';

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
  private ttlMs = PRE_LOGIN_CSRF_TTL_MS;
  private maxEntries = DEFAULT_MAX_ENTRIES;
  private readonly entries = new Map<string, PreLoginCsrfEntry>();

  static withOptions(options: PreLoginCsrfOptions): PreLoginCsrfStore {
    const store = new PreLoginCsrfStore();
    if (options.ttlMs !== undefined) {
      store.ttlMs = options.ttlMs;
    }
    if (options.maxEntries !== undefined) {
      store.maxEntries = options.maxEntries;
    }
    return store;
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

    const cookieValue = generateRandomToken();
    const csrfToken = generateRandomToken();
    this.entries.set(sha256Hex(cookieValue), {
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

    const key = sha256Hex(cookieValue);
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
    this.entries.delete(sha256Hex(cookieValue));
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
