import { config } from 'dotenv';

// Test configuration is explicit: `.env.test` wins over the local `.env`.
// Ambient process variables still take precedence over both files.
config({ path: ['.env.test', '.env'], quiet: true });
process.env.NODE_ENV = 'test';
