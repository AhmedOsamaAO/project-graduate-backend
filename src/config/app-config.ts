import { isAbsolute, resolve } from 'node:path';

export const APP_ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export const CSRF_MODES = ['synchronizer', 'disabled'] as const;
export type CsrfMode = (typeof CSRF_MODES)[number];

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES = 120;
const DEFAULT_SESSION_ABSOLUTE_TIMEOUT_DAYS = 7;
const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

export interface AppConfig {
  readonly environment: AppEnvironment;
  readonly isProduction: boolean;
  readonly databaseUrl: string;
  readonly port: number;
  readonly host: string;
  readonly frontendOrigins: readonly string[];
  readonly cookieSecure: boolean;
  readonly csrfMode: CsrfMode;
  readonly sessionIdleTimeoutMinutes: number;
  readonly sessionAbsoluteTimeoutDays: number;
  readonly privateStorageRoot: string;
  readonly uploadMaxBytes: number;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Validates the complete runtime configuration in one place. Callers pass an
 * environment object so tests can exercise startup failures without mutating
 * process-wide state.
 */
export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = parseEnvironment(env.NODE_ENV);
  const isProduction = environment === 'production';

  const databaseUrl = requireValue(env, 'DATABASE_URL');
  assertPostgresUrl(databaseUrl);

  const port = parseInteger(env.PORT, 'PORT', DEFAULT_PORT, 1, 65535);
  const host = env.HOST?.trim() || DEFAULT_HOST;
  assertHost(host, isProduction);

  const frontendOrigins = parseFrontendOrigins(
    requireValue(env, 'FRONTEND_ORIGINS'),
    isProduction,
  );

  const cookieSecure = parseBoolean(
    env.COOKIE_SECURE,
    'COOKIE_SECURE',
    isProduction,
  );
  if (isProduction && !cookieSecure) {
    throw new ConfigurationError('COOKIE_SECURE must be true in production');
  }

  const csrfMode = parseEnum(
    env.CSRF_MODE,
    'CSRF_MODE',
    CSRF_MODES,
    'synchronizer',
  );
  if (isProduction && csrfMode !== 'synchronizer') {
    throw new ConfigurationError(
      'CSRF_MODE must be "synchronizer" in production',
    );
  }

  const sessionIdleTimeoutMinutes = parseInteger(
    env.SESSION_IDLE_TIMEOUT_MINUTES,
    'SESSION_IDLE_TIMEOUT_MINUTES',
    DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES,
    1,
    60 * 24 * 30,
  );
  const sessionAbsoluteTimeoutDays = parseInteger(
    env.SESSION_ABSOLUTE_TIMEOUT_DAYS,
    'SESSION_ABSOLUTE_TIMEOUT_DAYS',
    DEFAULT_SESSION_ABSOLUTE_TIMEOUT_DAYS,
    1,
    365,
  );
  if (sessionAbsoluteTimeoutDays * 24 * 60 <= sessionIdleTimeoutMinutes) {
    throw new ConfigurationError(
      'SESSION_ABSOLUTE_TIMEOUT_DAYS must exceed SESSION_IDLE_TIMEOUT_MINUTES',
    );
  }

  const privateStorageRoot = parseStorageRoot(env, isProduction);
  const uploadMaxBytes = parseInteger(
    env.UPLOAD_MAX_BYTES,
    'UPLOAD_MAX_BYTES',
    DEFAULT_UPLOAD_MAX_BYTES,
    1,
    MAX_UPLOAD_MAX_BYTES,
  );

  return {
    environment,
    isProduction,
    databaseUrl,
    port,
    host,
    frontendOrigins,
    cookieSecure,
    csrfMode,
    sessionIdleTimeoutMinutes,
    sessionAbsoluteTimeoutDays,
    privateStorageRoot,
    uploadMaxBytes,
  };
}

function parseEnvironment(value: string | undefined): AppEnvironment {
  const environment = value?.trim();
  if (!environment) {
    throw new ConfigurationError(
      'NODE_ENV is required and must be development, test, or production',
    );
  }
  if (!APP_ENVIRONMENTS.includes(environment as AppEnvironment)) {
    throw new ConfigurationError(
      'NODE_ENV must be development, test, or production',
    );
  }
  return environment as AppEnvironment;
}

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigurationError(`${name} is required`);
  }
  return value;
}

function assertPostgresUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(
      'DATABASE_URL must be a valid PostgreSQL connection string',
    );
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ConfigurationError(
      'DATABASE_URL must use the postgres or postgresql protocol',
    );
  }
  if (!url.hostname) {
    throw new ConfigurationError('DATABASE_URL must include a host');
  }
}

function parseInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new ConfigurationError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }

  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new ConfigurationError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function parseBoolean(
  value: string | undefined,
  name: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  switch (value.trim().toLowerCase()) {
    case 'true':
    case '1':
      return true;
    case 'false':
    case '0':
      return false;
    default:
      throw new ConfigurationError(`${name} must be true or false`);
  }
}

function parseEnum<T extends string>(
  value: string | undefined,
  name: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const normalized = value?.trim() as T | undefined;
  if (!normalized) {
    return defaultValue;
  }
  if (!allowed.includes(normalized)) {
    throw new ConfigurationError(
      `${name} must be one of: ${allowed.join(', ')}`,
    );
  }
  return normalized;
}

function assertHost(host: string, isProduction: boolean): void {
  if (/\s/.test(host) || host.includes('/')) {
    throw new ConfigurationError('HOST must be a hostname or IP address');
  }
  if (isProduction && !LOOPBACK_HOSTS.has(host)) {
    throw new ConfigurationError(
      'HOST must bind loopback (127.0.0.1 or ::1) in production',
    );
  }
}

function parseFrontendOrigins(
  value: string,
  isProduction: boolean,
): readonly string[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new ConfigurationError(
      'FRONTEND_ORIGINS must contain at least one exact origin',
    );
  }

  const origins = entries.map((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new ConfigurationError(
        'FRONTEND_ORIGINS must contain only absolute http(s) origins',
      );
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ConfigurationError(
        'FRONTEND_ORIGINS must contain only absolute http(s) origins',
      );
    }
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new ConfigurationError(
        'FRONTEND_ORIGINS entries must be exact origins without paths, credentials, queries, or fragments',
      );
    }
    if (isProduction && url.protocol !== 'https:') {
      throw new ConfigurationError(
        'FRONTEND_ORIGINS must use https in production',
      );
    }

    return url.origin;
  });

  if (new Set(origins).size !== origins.length) {
    throw new ConfigurationError(
      'FRONTEND_ORIGINS must not contain duplicate origins',
    );
  }

  return origins;
}

function parseStorageRoot(
  env: NodeJS.ProcessEnv,
  isProduction: boolean,
): string {
  const configured = env.PRIVATE_STORAGE_ROOT?.trim();

  if (!configured) {
    if (isProduction) {
      throw new ConfigurationError('PRIVATE_STORAGE_ROOT is required');
    }
    return resolve(process.cwd(), 'storage');
  }

  if (!isAbsolute(configured)) {
    throw new ConfigurationError(
      'PRIVATE_STORAGE_ROOT must be an absolute path',
    );
  }

  return resolve(configured);
}
