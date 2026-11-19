import { parseArgs } from 'node:util';
import { password as promptPassword } from '@inquirer/prompts';
import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { StaffAccounts } from './staff-accounts';

type AccountCommands = Pick<
  StaffAccounts,
  'provision' | 'resetPassword' | 'deactivate'
>;

export type PasswordPrompt = (
  config: { message: string; mask?: boolean | string },
  context?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream },
) => Promise<string>;

export interface PasswordInputOptions {
  readonly stdin?: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly stderr?: NodeJS.WritableStream & { readonly isTTY?: boolean };
  readonly prompt?: PasswordPrompt;
}

export async function readPasswordInput(
  options: PasswordInputOptions = {},
): Promise<string> {
  const stdin = options.stdin ?? process.stdin;
  const stderr = options.stderr ?? process.stderr;
  const prompt = options.prompt ?? promptPassword;

  if (stdin.isTTY) {
    if (!stderr.isTTY) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        ERROR_CODES.VALIDATION_ERROR,
        'Interactive password prompts require a terminal on stdin and stderr; pipe one password line on stdin for non-interactive use',
      );
    }
    const context = { input: stdin, output: stderr };
    const first = await prompt({ message: 'Password:', mask: '*' }, context);
    const second = await prompt(
      { message: 'Confirm password:', mask: '*' },
      context,
    );
    if (first !== second) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        ERROR_CODES.VALIDATION_ERROR,
        'Password confirmation did not match',
      );
    }
    return first;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer =
      typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 1026) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        ERROR_CODES.VALIDATION_ERROR,
        'Password input too large',
      );
    }
    chunks.push(buffer);
  }
  const input = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
  if (/[\r\n]/.test(input)) {
    throw new ApiError(
      HttpStatus.BAD_REQUEST,
      ERROR_CODES.VALIDATION_ERROR,
      'Expected one password line',
    );
  }
  return input;
}

export async function runOperatorCommand(
  args: string[],
  accounts: AccountCommands,
  readPassword: () => Promise<string>,
) {
  const [command, ...options] = args;
  if (!['create', 'reset', 'deactivate'].includes(command)) invalid();
  const allowed =
    command === 'create'
      ? ['operator', 'username', 'full-name']
      : ['operator', 'id', 'expected-version'];
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: options,
      options: Object.fromEntries(
        allowed.map((name) => [name, { type: 'string' as const }]),
      ),
      allowPositionals: false,
      strict: true,
    }).values;
  } catch {
    invalid();
  }
  const required = (key: string): string => {
    const value = values[key];
    if (typeof value !== 'string' || !value.trim()) invalid();
    return value;
  };
  const actor = { attribution: required('operator') };
  if (command === 'create') {
    const username = required('username');
    const fullName = required('full-name');
    return accounts.provision(actor, {
      username,
      fullName,
      password: await readPassword(),
    });
  }
  const positiveInteger = (key: string): number => {
    const value = required(key);
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
      invalid();
    return Number(value);
  };
  const input = {
    id: positiveInteger('id'),
    expectedVersion: positiveInteger('expected-version'),
  };
  return command === 'reset'
    ? accounts.resetPassword(actor, {
        ...input,
        password: await readPassword(),
      })
    : accounts.deactivate(actor, input);
}

function invalid(): never {
  throw new ApiError(
    HttpStatus.BAD_REQUEST,
    ERROR_CODES.VALIDATION_ERROR,
    'Use create --operator NAME --username USER --full-name NAME, or reset/deactivate --operator NAME --id ID --expected-version VERSION. Passwords are accepted only from a hidden prompt or standard input.',
  );
}
