import { runOperatorCommand } from './operator-cli';

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
