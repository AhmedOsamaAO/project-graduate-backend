import 'reflect-metadata';
import { password } from '@inquirer/prompts';
import { PrismaPg } from '@prisma/adapter-pg';
import { ApiError } from '../common/errors/api-error';
import { loadEnvironment } from '../config/load-environment';
import { PrismaClient } from '../generated/prisma/client';
import { runOperatorCommand } from './operator-cli';
import { StaffAccounts } from './staff-accounts';
import { assertRuntimeRole } from '../prisma/runtime-role';

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    const first = await password({ message: 'Password:', mask: '*' });
    const second = await password({ message: 'Confirm password:', mask: '*' });
    if (first !== second) throw new Error('Password confirmation mismatch');
    return first;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 1026) throw new Error('Password input too large');
    chunks.push(buffer);
  }
  const input = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
  if (/[\r\n]/.test(input)) throw new Error('Expected one password line');
  return input;
}

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
      readPassword,
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
          code: 'OPERATOR_COMMAND_FAILED',
          message:
            'Command failed; check configuration, password input and database availability',
        };
  process.stderr.write(`${JSON.stringify(response)}\n`);
  process.exitCode = 1;
});
