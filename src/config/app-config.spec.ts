import { resolve } from 'node:path';
import {
  ConfigurationError,
  loadAppConfig,
  parseSessionIdleTimeoutMinutes,
} from './app-config';

function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:password@localhost:5432/records',
    PORT: '3000',
    HOST: '127.0.0.1',
    FRONTEND_ORIGINS: 'http://localhost:5173',
    COOKIE_SECURE: 'false',
    CSRF_MODE: 'synchronizer',
    SESSION_IDLE_TIMEOUT_MINUTES: '120',
    SESSION_ABSOLUTE_TIMEOUT_DAYS: '7',
    PRIVATE_STORAGE_ROOT: '/tmp/project-graduate-storage',
    UPLOAD_MAX_BYTES: '10485760',
  };
}

function productionEnv(): NodeJS.ProcessEnv {
  return {
    ...validEnv(),
    NODE_ENV: 'production',
    FRONTEND_ORIGINS: 'https://records.example.edu',
    COOKIE_SECURE: 'true',
    PRIVATE_STORAGE_ROOT: '/var/lib/project-graduate/storage',
  };
}

describe('loadAppConfig', () => {
  it('validates and normalizes the complete configuration', () => {
    const config = loadAppConfig({
      ...validEnv(),
      FRONTEND_ORIGINS: 'http://localhost:5173/, https://frontend.example.edu',
    });

    expect(config).toMatchObject({
      environment: 'development',
      isProduction: false,
      databaseUrl: 'postgresql://user:password@localhost:5432/records',
      port: 3000,
      host: '127.0.0.1',
      frontendOrigins: [
        'http://localhost:5173',
        'https://frontend.example.edu',
      ],
      cookieSecure: false,
      csrfMode: 'synchronizer',
      sessionIdleTimeoutMinutes: 120,
      sessionAbsoluteTimeoutDays: 7,
      sessionCleanupIntervalMinutes: 15,
      privateStorageRoot: '/tmp/project-graduate-storage',
      uploadMaxBytes: 10485760,
      fileOperationReconciliationIntervalSeconds: 60,
      fileOperationLeaseSeconds: 120,
    });
  });

  it('applies development-safe defaults for optional values', () => {
    const env = validEnv();
    delete env.PORT;
    delete env.HOST;
    delete env.SESSION_IDLE_TIMEOUT_MINUTES;
    delete env.SESSION_ABSOLUTE_TIMEOUT_DAYS;
    delete env.PRIVATE_STORAGE_ROOT;
    delete env.UPLOAD_MAX_BYTES;
    delete env.FILE_OPERATION_RECONCILIATION_INTERVAL_SECONDS;
    delete env.FILE_OPERATION_LEASE_SECONDS;

    const config = loadAppConfig(env);

    expect(config.port).toBe(3000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.sessionIdleTimeoutMinutes).toBe(120);
    expect(config.sessionAbsoluteTimeoutDays).toBe(7);
    expect(config.sessionCleanupIntervalMinutes).toBe(15);
    expect(config.privateStorageRoot).toBe(resolve(process.cwd(), 'storage'));
    expect(config.uploadMaxBytes).toBe(10 * 1024 * 1024);
    expect(config.fileOperationReconciliationIntervalSeconds).toBe(60);
    expect(config.fileOperationLeaseSeconds).toBe(120);
  });

  it('accepts explicit production loopback and secure settings', () => {
    const config = loadAppConfig(productionEnv());

    expect(config.environment).toBe('production');
    expect(config.isProduction).toBe(true);
  });

  it('requires an explicit environment mode', () => {
    const env = validEnv();
    delete env.NODE_ENV;

    expect(() => loadAppConfig(env)).toThrow(ConfigurationError);
    expect(() => loadAppConfig(env)).toThrow(/NODE_ENV is required/);
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'not-a-url'],
    ['non-postgres', 'mysql://user:password@localhost:3306/records'],
  ])('rejects a %s DATABASE_URL', (_label, databaseUrl) => {
    const env = { ...validEnv(), DATABASE_URL: databaseUrl };

    expect(() => loadAppConfig(env)).toThrow(ConfigurationError);
  });

  it('does not include the database URL in configuration errors', () => {
    expect(() =>
      loadAppConfig({
        ...validEnv(),
        DATABASE_URL: 'not-a-url?password=super-secret',
      }),
    ).toThrow(/DATABASE_URL must be a valid PostgreSQL connection string/);

    try {
      loadAppConfig({
        ...validEnv(),
        DATABASE_URL: 'not-a-url?password=super-secret',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('super-secret');
    }
  });

  it.each([
    ['missing', undefined],
    ['wildcard', '*'],
    ['with a path', 'https://frontend.example.edu/app'],
    ['with credentials', 'https://user:pass@frontend.example.edu'],
    ['with a query', 'https://frontend.example.edu?debug=1'],
    [
      'duplicated',
      'https://frontend.example.edu, https://frontend.example.edu/',
    ],
  ])('rejects FRONTEND_ORIGINS that are %s', (_label, origins) => {
    expect(() =>
      loadAppConfig({ ...validEnv(), FRONTEND_ORIGINS: origins }),
    ).toThrow(ConfigurationError);
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', 'not-a-number'],
    ['SESSION_IDLE_TIMEOUT_MINUTES', '0'],
    ['SESSION_ABSOLUTE_TIMEOUT_DAYS', 'nope'],
    ['SESSION_CLEANUP_INTERVAL_MINUTES', '0'],
    ['SESSION_CLEANUP_INTERVAL_MINUTES', '1441'],
    ['UPLOAD_MAX_BYTES', '-1'],
    ['FILE_OPERATION_RECONCILIATION_INTERVAL_SECONDS', '0'],
    ['FILE_OPERATION_RECONCILIATION_INTERVAL_SECONDS', '3601'],
    ['FILE_OPERATION_LEASE_SECONDS', '4'],
    ['FILE_OPERATION_LEASE_SECONDS', '3601'],
    ['COOKIE_SECURE', 'sometimes'],
  ])('rejects an invalid %s', (name, value) => {
    expect(() => loadAppConfig({ ...validEnv(), [name]: value })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects multiple production frontend origins', () => {
    expect(() =>
      loadAppConfig({
        ...productionEnv(),
        FRONTEND_ORIGINS:
          'https://records.example.edu, https://second.example.edu',
      }),
    ).toThrow(/exactly one origin in production/);
  });

  it('rejects an idle timeout that is not shorter than the absolute timeout', () => {
    expect(() =>
      loadAppConfig({
        ...validEnv(),
        SESSION_IDLE_TIMEOUT_MINUTES: String(7 * 24 * 60),
        SESSION_ABSOLUTE_TIMEOUT_DAYS: '7',
      }),
    ).toThrow(/must exceed/);
  });

  it('rejects a relative private storage root', () => {
    expect(() =>
      loadAppConfig({ ...validEnv(), PRIVATE_STORAGE_ROOT: 'storage' }),
    ).toThrow(/absolute path/);
  });

  it.each([
    ['non-loopback host', { HOST: '0.0.0.0' }],
    [
      'http frontend origin',
      { FRONTEND_ORIGINS: 'http://records.example.edu' },
    ],
    ['insecure cookie', { COOKIE_SECURE: 'false' }],
    ['disabled CSRF', { CSRF_MODE: 'disabled' }],
    ['missing storage root', { PRIVATE_STORAGE_ROOT: undefined }],
  ])('rejects production configuration with %s', (_label, overrides) => {
    expect(() => loadAppConfig({ ...productionEnv(), ...overrides })).toThrow(
      ConfigurationError,
    );
  });

  it('validates custom SESSION_CLEANUP_INTERVAL_MINUTES and standalone idle parser', () => {
    const config = loadAppConfig({
      ...validEnv(),
      SESSION_CLEANUP_INTERVAL_MINUTES: '30',
    });
    expect(config.sessionCleanupIntervalMinutes).toBe(30);
    expect(parseSessionIdleTimeoutMinutes(undefined)).toBe(120);
    expect(parseSessionIdleTimeoutMinutes('45')).toBe(45);
    expect(() => parseSessionIdleTimeoutMinutes('0')).toThrow(
      ConfigurationError,
    );
  });
});
