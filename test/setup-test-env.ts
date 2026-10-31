import { config } from 'dotenv';

// Test configuration is explicit: `.env.test` wins over the local `.env`.
// Ambient process variables still take precedence over both files.
config({ path: ['.env.test', '.env'], quiet: true });
process.env.NODE_ENV = 'test';

const testDefaults: Readonly<Record<string, string>> = {
  PORT: '3000',
  HOST: '127.0.0.1',
  FRONTEND_ORIGINS: 'http://localhost:5173',
  COOKIE_SECURE: 'false',
  CSRF_MODE: 'synchronizer',
  SESSION_IDLE_TIMEOUT_MINUTES: '120',
  SESSION_ABSOLUTE_TIMEOUT_DAYS: '7',
  UPLOAD_MAX_BYTES: String(10 * 1024 * 1024),
};

for (const [name, value] of Object.entries(testDefaults)) {
  if (process.env[name] === undefined) {
    process.env[name] = value;
  }
}
