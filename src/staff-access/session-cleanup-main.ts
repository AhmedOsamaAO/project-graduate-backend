import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  ConfigurationError,
  parseSessionIdleTimeoutMinutes,
} from '../config/app-config';
import { loadEnvironment } from '../config/load-environment';
import { PrismaClient } from '../generated/prisma/client';
import { assertRuntimeRole } from '../prisma/runtime-role';
import { cleanupExpiredSessions } from './session-cleanup';

async function main(): Promise<void> {
  loadEnvironment();
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new ConfigurationError('Runtime connection missing');
  }
  const idleTimeoutMinutes = parseSessionIdleTimeoutMinutes(
    process.env.SESSION_IDLE_TIMEOUT_MINUTES,
  );
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  try {
    await assertRuntimeRole(prisma);
    const result = await cleanupExpiredSessions(prisma, idleTimeoutMinutes);
    process.stdout.write(`${JSON.stringify({ data: result })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  // Never print raw driver errors, connection strings, or stacks.
  const response =
    error instanceof ApiError
      ? { code: error.code, message: error.message }
      : error instanceof ConfigurationError
        ? { code: ERROR_CODES.VALIDATION_ERROR, message: error.message }
        : {
            code: ERROR_CODES.OPERATOR_COMMAND_FAILED,
            message:
              'Command failed; check configuration and database availability',
          };
  process.stderr.write(`${JSON.stringify(response)}\n`);
  process.exitCode = 1;
});
