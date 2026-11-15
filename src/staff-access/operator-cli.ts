import { parseArgs } from 'node:util';
import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import type { StaffAccounts } from './staff-accounts';

type AccountCommands = Pick<
  StaffAccounts,
  'provision' | 'resetPassword' | 'deactivate'
>;

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
  const number = (key: string): number => {
    const value = required(key);
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
      invalid();
    return Number(value);
  };
  const input = {
    id: number('id'),
    expectedVersion: number('expected-version'),
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
    'VALIDATION_ERROR',
    'Use create --operator NAME --username USER --full-name NAME, or reset/deactivate --operator NAME --id ID --expected-version VERSION. Passwords are accepted only from a hidden prompt or standard input.',
  );
}
