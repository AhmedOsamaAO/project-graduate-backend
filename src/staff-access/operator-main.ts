import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import { loadEnvironment } from '../config/load-environment';
import { PrismaClient } from '../generated/prisma/client';
import { readPasswordInput, runOperatorCommand } from './operator-cli';
import { StaffAccounts } from './staff-accounts';
import { assertRuntimeRole } from '../prisma/runtime-role';

async function main(): Promise<void> {
  loadEnvironment();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Runtime connection missing');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  try {
    await assertRuntimeRole(prisma);
    const result = await runOperatorCommand(
      process.argv.slice(2),
      new StaffAccounts(prisma),
      () => readPasswordInput(),
    );
    process.stdout.write(`${JSON.stringify({ data: result })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  // Never print raw driver errors, input, hashes, connection strings or stacks.
  const response =
    error instanceof ApiError
      ? { code: error.code, message: error.message }
      : {
          code: ERROR_CODES.OPERATOR_COMMAND_FAILED,
          message:
            'Command failed; check configuration, password input and database availability',
        };
  process.stderr.write(`${JSON.stringify(response)}\n`);
  process.exitCode = 1;
});
