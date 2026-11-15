import { PrismaPg } from '@prisma/adapter-pg';
import { verify } from 'argon2';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { spawn } from 'node:child_process';
import { PrismaClient } from '../../src/generated/prisma/client';
import { StaffAccounts } from '../../src/staff-access/staff-accounts';
import { assertRuntimeRole } from '../../src/prisma/runtime-role';
import {
  createTestDatabase,
  type TestDatabase,
} from '../support/test-database';

describe('operator account commands', () => {
  let database: TestDatabase;
  let prisma: PrismaClient;
  let accounts: StaffAccounts;

  beforeAll(async () => {
    database = await createTestDatabase();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: database.runtimeUrl }),
    });
    accounts = new StaffAccounts(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.drop();
  });

  it('provisions a canonical individual account with safe operator-attributed history', async () => {
    const staff = await accounts.provision(
      { attribution: 'test operator' },
      {
        username: '  OFFICE.User  ',
        fullName: 'Office User',
        password: 'a long individual password',
      },
    );
    expect(staff).toMatchObject({
      username: 'office.user',
      fullName: 'Office User',
      version: 1,
      deactivatedAt: null,
    });
    expect(staff).not.toHaveProperty('passwordHash');
    const stored = await prisma.staffUser.findUniqueOrThrow({
      where: { id: staff.id },
    });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(
      await verify(stored.passwordHash, 'a long individual password'),
    ).toBe(true);
    const history = await prisma.changeHistory.findMany({
      where: { recordId: staff.id },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      recordType: 'STAFF_USER',
      action: 'ACCOUNT_PROVISIONED',
      actorKind: 'OPERATOR',
      staffUserId: null,
      operatorAttribution: 'test operator',
      before: null,
      after: staff,
    });
    expect(JSON.stringify(history)).not.toContain(stored.passwordHash);
    expect(JSON.stringify(history)).not.toContain('a long individual password');
  });

  it('resets credentials and deactivates with atomic session invalidation and safe history', async () => {
    const staff = await accounts.provision(
      { attribution: 'operator one' },
      {
        username: 'reset.user',
        fullName: 'Reset User',
        password: 'initial unique password',
      },
    );
    const addSession = () =>
      prisma.staffSession.create({
        data: {
          staffUserId: staff.id,
          authVersion: 1,
          credentialDigest: randomBytes(32).toString('hex'),
          csrfSecret: randomBytes(32).toString('hex'),
          absoluteExpiresAt: new Date(Date.now() + 60000),
        },
      });
    await addSession();
    const reset = await accounts.resetPassword(
      { attribution: 'operator two' },
      {
        id: staff.id,
        expectedVersion: 1,
        password: 'replacement unique password',
      },
    );
    expect(reset.version).toBe(2);
    expect(
      await prisma.staffSession.count({ where: { staffUserId: staff.id } }),
    ).toBe(0);
    const stored = await prisma.staffUser.findUniqueOrThrow({
      where: { id: staff.id },
    });
    expect(stored.authVersion).toBe(2);
    expect(
      await verify(stored.passwordHash, 'replacement unique password'),
    ).toBe(true);
    await addSession();
    const deactivated = await accounts.deactivate(
      { attribution: 'operator two' },
      { id: staff.id, expectedVersion: 2 },
    );
    expect(deactivated.version).toBe(3);
    expect(deactivated.deactivatedAt).toEqual(expect.any(String));
    expect(
      await prisma.staffSession.count({ where: { staffUserId: staff.id } }),
    ).toBe(0);
    expect(
      (await prisma.staffUser.findUniqueOrThrow({ where: { id: staff.id } }))
        .authVersion,
    ).toBe(3);
    const history = await prisma.changeHistory.findMany({
      where: { recordId: staff.id },
      orderBy: { id: 'asc' },
    });
    expect(history.map(({ action }) => action)).toEqual([
      'ACCOUNT_PROVISIONED',
      'PASSWORD_RESET',
      'ACCOUNT_DEACTIVATED',
    ]);
    expect(history[1]).toMatchObject({
      before: staff,
      after: reset,
      actorKind: 'OPERATOR',
      staffUserId: null,
      operatorAttribution: 'operator two',
    });
    expect(history[2]).toMatchObject({ before: reset, after: deactivated });
    expect(JSON.stringify(history)).not.toMatch(
      /passwordHash|authVersion|credentialDigest|csrfSecret|replacement unique password/,
    );
  });

  it('allows only one of two competing versioned commands to commit', async () => {
    const staff = await accounts.provision(
      { attribution: 'race operator' },
      {
        username: 'race.user',
        fullName: 'Race User',
        password: 'individual race password',
      },
    );
    const results = await Promise.allSettled([
      accounts.deactivate(
        { attribution: 'race one' },
        { id: staff.id, expectedVersion: 1 },
      ),
      accounts.deactivate(
        { attribution: 'race two' },
        { id: staff.id, expectedVersion: 1 },
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'STALE_VERSION' } });
    expect(
      await prisma.changeHistory.count({ where: { recordId: staff.id } }),
    ).toBe(2);
  });

  it('rejects duplicate canonical usernames even when provisioned concurrently', async () => {
    const input = {
      username: 'Unique.User',
      fullName: 'Unique User',
      password: 'individual unique password',
    };
    const results = await Promise.allSettled([
      accounts.provision({ attribution: 'operator' }, input),
      accounts.provision(
        { attribution: 'operator' },
        { ...input, username: ' unique.user ' },
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'USERNAME_EXISTS' } });
  });

  it('rolls back the account and session deletion if mandatory history cannot be appended', async () => {
    const staff = await accounts.provision(
      { attribution: 'rollback operator' },
      {
        username: 'rollback.user',
        fullName: 'Rollback User',
        password: 'individual rollback password',
      },
    );
    await prisma.staffSession.create({
      data: {
        staffUserId: staff.id,
        authVersion: 1,
        credentialDigest: randomBytes(32).toString('hex'),
        csrfSecret: randomBytes(32).toString('hex'),
        absoluteExpiresAt: new Date(Date.now() + 60000),
      },
    });
    const admin = new Client({ connectionString: database.url });
    await admin.connect();
    try {
      await admin.query(
        'REVOKE INSERT ON change_history FROM graduate_runtime',
      );
      await expect(
        accounts.deactivate(
          { attribution: 'operator' },
          { id: staff.id, expectedVersion: 1 },
        ),
      ).rejects.toThrow();
      expect(
        await prisma.staffUser.findUniqueOrThrow({ where: { id: staff.id } }),
      ).toMatchObject({ version: 1, authVersion: 1, deactivatedAt: null });
      expect(
        await prisma.staffSession.count({ where: { staffUserId: staff.id } }),
      ).toBe(1);
      expect(
        await prisma.changeHistory.count({ where: { recordId: staff.id } }),
      ).toBe(1);
    } finally {
      await admin.query('GRANT INSERT ON change_history TO graduate_runtime');
      await admin.end();
    }
  });

  it('proves the actual runtime login cannot update, delete or truncate history', async () => {
    const client = new Client({ connectionString: database.runtimeUrl });
    await client.connect();
    try {
      const result = await client.query<{ rolsuper: boolean }>(
        'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
      );
      expect(result.rows[0].rolsuper).toBe(false);
      for (const sql of [
        "UPDATE change_history SET operator_attribution = 'forged'",
        'DELETE FROM change_history',
        'TRUNCATE change_history',
      ]) {
        await expect(client.query(sql)).rejects.toMatchObject({
          code: '42501',
        });
      }
      await expect(
        client.query('SET ROLE graduate_runtime'),
      ).resolves.toBeDefined();
      await expect(
        client.query('TRUNCATE change_history'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
  });

  it('rejects invalid input without creating accounts or history', async () => {
    const count = await prisma.changeHistory.count();
    for (const input of [
      {
        username: 'nonascii.İ',
        fullName: 'Name',
        password: 'long enough password',
      },
      { username: 'weak', fullName: 'Name', password: 'short' },
      { username: 'empty', fullName: ' ', password: 'long enough password' },
    ]) {
      await expect(
        accounts.provision({ attribution: 'operator' }, input),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(await prisma.changeHistory.count()).toBe(count);
  });

  it('rejects the owner connection and accepts the real runtime login', async () => {
    await expect(assertRuntimeRole(prisma)).resolves.toBeUndefined();
    const owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: database.url }),
    });
    try {
      await expect(assertRuntimeRole(owner)).rejects.toThrow(
        'Runtime database role',
      );
    } finally {
      await owner.$disconnect();
    }
  });

  it('runs the built CLI with stdin passwords, safe output and nonzero failures', async () => {
    const build = await child('npm', ['run', 'build']);
    expect(build.code).toBe(0);
    const command = ['dist/staff-access/operator-main.js'];
    const created = await child(
      process.execPath,
      [
        ...command,
        'create',
        '--operator',
        'CLI operator',
        '--username',
        'cli.user',
        '--full-name',
        'CLI User',
      ],
      'CLI individual password\n',
      database.runtimeUrl,
    );
    expect(created.code).toBe(0);
    expect(created.stderr).toBe('');
    const response = JSON.parse(created.stdout) as {
      data: { id: number; version: number; username: string };
    };
    expect(response.data).toMatchObject({ username: 'cli.user', version: 1 });
    expect(created.stdout).not.toMatch(/password|Hash|Digest|csrf|authVersion/);
    const reset = await child(
      process.execPath,
      [
        ...command,
        'reset',
        '--operator',
        'CLI operator',
        '--id',
        String(response.data.id),
        '--expected-version',
        '1',
      ],
      'new CLI individual password\n',
      database.runtimeUrl,
    );
    expect(reset.code).toBe(0);
    const deactivated = await child(
      process.execPath,
      [
        ...command,
        'deactivate',
        '--operator',
        'CLI operator',
        '--id',
        String(response.data.id),
        '--expected-version',
        '2',
      ],
      '',
      database.runtimeUrl,
    );
    expect(deactivated.code).toBe(0);
    const unsafe = await child(
      process.execPath,
      [...command, 'create', '--password', 'never-echo-this-secret'],
      '',
      database.runtimeUrl,
    );
    expect(unsafe.code).toBe(1);
    expect(unsafe.stdout).toBe('');
    expect(unsafe.stderr).toContain('VALIDATION_ERROR');
    expect(unsafe.stderr).not.toContain('never-echo-this-secret');
    const multipleLines = await child(
      process.execPath,
      [
        ...command,
        'reset',
        '--operator',
        'CLI operator',
        '--id',
        String(response.data.id),
        '--expected-version',
        '3',
      ],
      'first secret line\nsecond secret line\n',
      database.runtimeUrl,
    );
    expect(multipleLines.code).toBe(1);
    expect(multipleLines.stderr).not.toContain('secret line');
    const privileged = await child(
      process.execPath,
      [
        ...command,
        'deactivate',
        '--operator',
        'CLI operator',
        '--id',
        '1',
        '--expected-version',
        '1',
      ],
      '',
      database.url,
    );
    expect(privileged.code).toBe(1);
    expect(privileged.stderr).toContain('OPERATOR_COMMAND_FAILED');
    expect(privileged.stderr).not.toContain(database.url);
  });
});

function child(
  command: string,
  args: string[],
  input = '',
  databaseUrl?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, {
      env: {
        ...global.process.env,
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    process.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    process.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    process.once('error', reject);
    process.once('close', (code) => resolve({ code, stdout, stderr }));
    process.stdin.end(input);
  });
}
