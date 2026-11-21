import type { CookieOptions } from 'express';
import type { AppConfig } from '../config/app-config';

export const PRE_LOGIN_CSRF_TTL_MS = 15 * 60 * 1000;

const SESSION_COOKIE_BASE = 'graduate_session';
const CSRF_COOKIE_BASE = 'graduate_csrf';
const DAY_MS = 24 * 60 * 60 * 1000;

export function sessionCookieName(
  config: Pick<AppConfig, 'cookieSecure'>,
): string {
  return config.cookieSecure
    ? `__Host-${SESSION_COOKIE_BASE}`
    : SESSION_COOKIE_BASE;
}

export function csrfCookieName(
  config: Pick<AppConfig, 'cookieSecure'>,
): string {
  return config.cookieSecure ? `__Host-${CSRF_COOKIE_BASE}` : CSRF_COOKIE_BASE;
}

/** Shared host-only cookie attributes (`HttpOnly`, `Path=/`, `SameSite=Lax`, no `Domain`). */
export function clearCookieOptions(
  config: Pick<AppConfig, 'cookieSecure'>,
): CookieOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
  };
}

export function sessionCookieOptions(
  config: Pick<AppConfig, 'cookieSecure' | 'sessionAbsoluteTimeoutDays'>,
): CookieOptions {
  return {
    ...clearCookieOptions(config),
    maxAge: config.sessionAbsoluteTimeoutDays * DAY_MS,
  };
}

export function csrfCookieOptions(
  config: Pick<AppConfig, 'cookieSecure'>,
): CookieOptions {
  return {
    ...clearCookieOptions(config),
    maxAge: PRE_LOGIN_CSRF_TTL_MS,
  };
}

/**
 * Parses a single cookie value from an HTTP `Cookie` header without external
 * middleware. Returns `undefined` when absent or duplicated to prevent
 * cookie-tossing ambiguity.
 */
export function parseCookieValue(
  header: string | string[] | undefined,
  targetName: string,
): string | undefined {
  if (!header) {
    return undefined;
  }

  const combined = Array.isArray(header) ? header.join('; ') : header;
  let found: string | undefined;
  let matches = 0;

  for (const segment of combined.split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = segment.slice(0, separator).trim();
    if (name !== targetName) {
      continue;
    }
    matches += 1;
    if (matches > 1) {
      return undefined;
    }
    found = segment.slice(separator + 1).trim();
  }

  return matches === 1 && found !== '' ? found : undefined;
}
