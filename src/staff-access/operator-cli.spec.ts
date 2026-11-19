import { PassThrough } from 'node:stream';
import { ERROR_CODES } from '../common/errors/error-codes';
import { readPasswordInput, runOperatorCommand } from './operator-cli';

describe('operator command boundary', () => {
  it('reads a password from the input boundary, never an argument', async () => {
    const provision = jest.fn().mockResolvedValue({ id: 1, version: 1 });
    const readPassword = jest
      .fn()
      .mockResolvedValue('individual input password');
    const result = await runOperatorCommand(
      [
        'create',
        '--operator',
        'Ahmed',
        '--username',
        'office.user',
        '--full-name',
        'Office User',
      ],
      { provision, resetPassword: jest.fn(), deactivate: jest.fn() },
      readPassword,
    );
    expect(result).toEqual({ id: 1, version: 1 });
    expect(provision).toHaveBeenCalledWith(
      { attribution: 'Ahmed' },
      {
        username: 'office.user',
        fullName: 'Office User',
        password: 'individual input password',
      },
    );
    expect(readPassword).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'create',
      '--operator',
      'Ahmed',
      '--username',
      'user',
      '--full-name',
      'Name',
      '--password',
      'do-not-echo-this',
    ],
    [
      'create',
      '--operator',
      'Ahmed',
      '--username',
      'user',
      '--full-name',
      'Name',
      'do-not-echo-this',
    ],
    ['reset', '--operator', 'Ahmed', '--id', '1'],
    [
      'deactivate',
      '--operator',
      'Ahmed',
      '--id',
      '1',
      '--expected-version',
      '0',
    ],
    ['register'],
  ])(
    'rejects unsafe or incomplete arguments without reading secrets (%s)',
    async (...args) => {
      const accounts = {
        provision: jest.fn(),
        resetPassword: jest.fn(),
        deactivate: jest.fn(),
      };
      const readPassword = jest.fn();
      await expect(
        runOperatorCommand(args, accounts, readPassword),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(readPassword).not.toHaveBeenCalled();
      expect(accounts.provision).not.toHaveBeenCalled();
      expect(accounts.resetPassword).not.toHaveBeenCalled();
      expect(accounts.deactivate).not.toHaveBeenCalled();
    },
  );

  it('passes the original version to reset and never prompts for deactivation', async () => {
    const accounts = {
      provision: jest.fn(),
      resetPassword: jest.fn(),
      deactivate: jest.fn(),
    };
    const readPassword = jest.fn().mockResolvedValue('individual password');
    await runOperatorCommand(
      ['reset', '--operator', 'Ahmed', '--id', '4', '--expected-version', '7'],
      accounts,
      readPassword,
    );
    expect(accounts.resetPassword).toHaveBeenCalledWith(
      { attribution: 'Ahmed' },
      { id: 4, expectedVersion: 7, password: 'individual password' },
    );
    await runOperatorCommand(
      [
        'deactivate',
        '--operator',
        'Ahmed',
        '--id',
        '4',
        '--expected-version',
        '8',
      ],
      accounts,
      readPassword,
    );
    expect(accounts.deactivate).toHaveBeenCalledWith(
      { attribution: 'Ahmed' },
      { id: 4, expectedVersion: 8 },
    );
    expect(readPassword).toHaveBeenCalledTimes(1);
  });
});

describe('operator password input boundary', () => {
  it('writes interactive masked prompts to stderr rather than stdout', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stderr = Object.assign(new PassThrough(), { isTTY: true });
    const prompt = jest
      .fn()
      .mockResolvedValueOnce('interactive unique password')
      .mockResolvedValueOnce('interactive unique password');

    await expect(readPasswordInput({ stdin, stderr, prompt })).resolves.toBe(
      'interactive unique password',
    );

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenNthCalledWith(
      1,
      { message: 'Password:', mask: '*' },
      { input: stdin, output: stderr },
    );
    expect(prompt).toHaveBeenNthCalledWith(
      2,
      { message: 'Confirm password:', mask: '*' },
      { input: stdin, output: stderr },
    );
  });

  it('rejects confirmation mismatch without echoing passwords', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stderr = Object.assign(new PassThrough(), { isTTY: true });
    const prompt = jest
      .fn()
      .mockResolvedValueOnce('first-secret-value')
      .mockResolvedValueOnce('second-secret-value');

    const failure = await readPasswordInput({ stdin, stderr, prompt }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    expect(JSON.stringify(failure)).not.toContain('first-secret-value');
    expect(JSON.stringify(failure)).not.toContain('second-secret-value');
  });

  it('rejects interactive prompting when stdin is a TTY but stderr is redirected', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stderr = Object.assign(new PassThrough(), { isTTY: false });
    const prompt = jest.fn();

    await expect(
      readPasswordInput({ stdin, stderr, prompt }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('reads a single bounded UTF-8 password line from stdin and strips only one trailing newline', async () => {
    const lfStream = Object.assign(new PassThrough(), { isTTY: false });
    lfStream.end('  padded password \n');
    await expect(readPasswordInput({ stdin: lfStream })).resolves.toBe(
      '  padded password ',
    );

    const crlfStream = Object.assign(new PassThrough(), { isTTY: false });
    crlfStream.end('crlf password\r\n');
    await expect(readPasswordInput({ stdin: crlfStream })).resolves.toBe(
      'crlf password',
    );

    const multiLine = Object.assign(new PassThrough(), { isTTY: false });
    multiLine.end('first line\nsecond line\n');
    await expect(readPasswordInput({ stdin: multiLine })).rejects.toMatchObject(
      { code: ERROR_CODES.VALIDATION_ERROR },
    );

    const oversized = Object.assign(new PassThrough(), { isTTY: false });
    oversized.end('a'.repeat(1027));
    await expect(readPasswordInput({ stdin: oversized })).rejects.toMatchObject(
      { code: ERROR_CODES.VALIDATION_ERROR },
    );
  });
});
