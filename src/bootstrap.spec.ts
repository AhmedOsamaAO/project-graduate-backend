import { createApplication } from './bootstrap';

function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
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

describe('createApplication', () => {
  it('fails before starting when required configuration is missing', async () => {
    const env = validEnv();
    delete env.DATABASE_URL;

    await expect(createApplication({ env })).rejects.toThrow(
      /DATABASE_URL is required/,
    );
  });

  it('fails before starting when an environment mode is invalid', async () => {
    await expect(
      createApplication({ env: { ...validEnv(), NODE_ENV: 'staging' } }),
    ).rejects.toThrow(/NODE_ENV must be/);
  });

  it('fails before starting when production would bind a public interface', async () => {
    await expect(
      createApplication({
        env: {
          ...validEnv(),
          NODE_ENV: 'production',
          HOST: '0.0.0.0',
          FRONTEND_ORIGINS: 'https://records.example.edu',
          COOKIE_SECURE: 'true',
        },
      }),
    ).rejects.toThrow(/HOST must bind loopback/);
  });
});
