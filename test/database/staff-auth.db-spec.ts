import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { verify } from 'argon2';
import { ERROR_CODES } from '../../src/common/errors/error-codes';
import { loadAppConfig, type AppConfig } from '../../src/config/app-config';
import { PrismaClient } from '../../src/generated/prisma/client';
import { LoginThrottler } from '../../src/staff-access/login-throttler';
import { verifyPassword } from '../../src/staff-access/passwords';
import { cleanupExpiredSessions } from '../../src/staff-access/session-cleanup';
import { StaffAccounts } from '../../src/staff-access/staff-accounts';
import { StaffAuthService } from '../../src/staff-access/staff-auth.service';
import {
  createTestDatabase,
  type TestDatabase,
} from '../support/test-database';

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class MutableClock {
  private current: Date;

  constructor(initial: Date) {
    this.current = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(next: Date): void {
    this.current = new Date(next.getTime());
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

describe('staff authentication, sessions, and cleanup (db)', () => {
  let database: TestDatabase;
  let prisma: PrismaClient;
  let accounts: StaffAccounts;
  let baseConfig: AppConfig;

  beforeAll(async () => {
    database = await createTestDatabase();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: database.runtimeUrl }),
    });
    accounts = new StaffAccounts(prisma);
    baseConfig = loadAppConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database.runtimeUrl,
      FRONTEND_ORIGINS: 'http://localhost:5173',
      COOKIE_SECURE: 'false',
      CSRF_MODE: 'synchronizer',
      SESSION_IDLE_TIMEOUT_MINUTES: '120',
      SESSION_ABSOLUTE_TIMEOUT_DAYS: '7',
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.drop();
  });

  function createAuthService(
    overrides: {
      config?: Partial<AppConfig>;
      clock?: MutableClock;
      throttler?: LoginThrottler;
      verifier?: (passwordHash: string, plain: string) => Promise<boolean>;
    } = {},
  ): StaffAuthService {
    return new StaffAuthService(
      prisma,
      { ...baseConfig, ...overrides.config },
      overrides.throttler ?? new LoginThrottler(),
      overrides.clock ?? new MutableClock(new Date('2026-11-20T12:00:00.000Z')),
      overrides.verifier,
    );
  }

  it('stores only SHA-256 digests, separate CSRF material, and staff-attributed SIGN_IN history', async () => {
    const clock = new MutableClock(new Date('2026-11-20T12:00:00.000Z'));
    const auth = createAuthService({ clock });
    const staff = await accounts.provision(
      { attribution: 'auth operator' },
      {
        username: 'SignIn.User',
        fullName: 'Sign In User',
        password: 'valid sign in password',
      },
    );

    const result = await auth.login({
      username: '  SIGNIN.USER  ',
      password: 'valid sign in password',
      clientIp: '127.0.0.1',
    });

    expect(result.user).toEqual(staff);
    expect(
      Buffer.from(result.rawSessionCredential, 'base64url').length,
    ).toBeGreaterThanOrEqual(32);
    expect(
      Buffer.from(result.csrfToken, 'base64url').length,
    ).toBeGreaterThanOrEqual(32);
    expect(result.csrfToken).not.toBe(result.rawSessionCredential);

    const expectedDigest = createHash('sha256')
      .update(result.rawSessionCredential, 'utf8')
      .digest('hex');

    const sessions = await prisma.staffSession.findMany({
      where: { staffUserId: staff.id },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].credentialDigest).toBe(expectedDigest);
    expect(sessions[0].credentialDigest).not.toBe(result.rawSessionCredential);
    expect(sessions[0].csrfSecret).toBe(result.csrfToken);
    expect(sessions[0].authVersion).toBe(1);
    expect(sessions[0].createdAt).toEqual(clock.now());
    expect(sessions[0].lastSeenAt).toEqual(clock.now());
    expect(sessions[0].absoluteExpiresAt).toEqual(
      new Date(clock.now().getTime() + 7 * 24 * 60 * 60 * 1000),
    );

    const history = await prisma.changeHistory.findMany({
      where: { recordId: staff.id, action: 'SIGN_IN' },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      recordType: 'STAFF_USER',
      recordId: staff.id,
      action: 'SIGN_IN',
      actorKind: 'STAFF',
      staffUserId: staff.id,
      operatorAttribution: null,
      before: null,
      after: staff,
    });
    expect(JSON.stringify(history)).not.toContain(result.rawSessionCredential);
    expect(JSON.stringify(history)).not.toContain(result.csrfToken);
    expect(JSON.stringify(history)).not.toContain('valid sign in password');
  });

  it('returns identical generic failures and records unauthenticated SIGN_IN_FAILED history without raw input', async () => {
    const auth = createAuthService();
    const active = await accounts.provision(
      { attribution: 'auth operator' },
      {
        username: 'fail.active',
        fullName: 'Fail Active',
        password: 'active account password',
      },
    );
    const deactivated = await accounts.provision(
      { attribution: 'auth operator' },
      {
        username: 'fail.deactivated',
        fullName: 'Fail Deactivated',
        password: 'deactivated account pass',
      },
    );
    await accounts.deactivate(
      { attribution: 'auth operator' },
      { id: deactivated.id, expectedVersion: 1 },
    );

    const baselineHistoryCount = await prisma.changeHistory.count();

    for (const attempt of [
      {
        username: 'unknown.person',
        password: 'secret-attempt-unknown',
        expectedRecordId: null,
      },
      {
        username: 'bad username! İ',
        password: 'secret-attempt-noncanonical',
        expectedRecordId: null,
      },
      {
        username: 'fail.active',
        password: 'secret-attempt-wrong-pass',
        expectedRecordId: active.id,
      },
      {
        username: 'fail.deactivated',
        password: 'deactivated account pass',
        expectedRecordId: deactivated.id,
      },
    ]) {
      const beforeCount = await prisma.changeHistory.count();
      await expect(
        auth.login({
          username: attempt.username,
          password: attempt.password,
          clientIp: '127.0.0.2',
        }),
      ).rejects.toMatchObject({
        status: 401,
        code: ERROR_CODES.UNAUTHENTICATED,
        message: 'Invalid username or password',
      });

      const created = await prisma.changeHistory.findMany({
        orderBy: { id: 'desc' },
        take: 1,
      });
      expect(await prisma.changeHistory.count()).toBe(beforeCount + 1);
      expect(created[0]).toMatchObject({
        recordType: 'STAFF_USER',
        recordId: attempt.expectedRecordId,
        action: 'SIGN_IN_FAILED',
        actorKind: 'UNAUTHENTICATED',
        staffUserId: null,
        operatorAttribution: null,
        before: null,
        after: null,
      });
    }

    const recentHistory = await prisma.changeHistory.findMany({
      orderBy: { id: 'desc' },
      take: 4,
    });
    expect(recentHistory).toHaveLength(4);
    expect(await prisma.changeHistory.count()).toBe(baselineHistoryCount + 4);
    const serialized = JSON.stringify(recentHistory);
    expect(serialized).not.toContain('unknown.person');
    expect(serialized).not.toContain('bad username');
    expect(serialized).not.toContain('secret-attempt');
    expect(serialized).not.toContain('deactivated account pass');
  });

  it('enforces idle/absolute expiry, touches without extending absolute expiry, and never recreates deleted sessions', async () => {
    const clock = new MutableClock(new Date('2026-11-20T08:00:00.000Z'));
    const auth = createAuthService({
      clock,
      config: {
        sessionIdleTimeoutMinutes: 30,
        sessionAbsoluteTimeoutDays: 1,
      },
    });
    const staff = await accounts.provision(
      { attribution: 'expiry operator' },
      {
        username: 'expiry.user',
        fullName: 'Expiry User',
        password: 'expiry password value',
      },
    );

    const sessionA = await auth.login({
      username: 'expiry.user',
      password: 'expiry password value',
      clientIp: '10.0.0.1',
    });
    const sessionB = await auth.login({
      username: 'expiry.user',
      password: 'expiry password value',
      clientIp: '10.0.0.1',
    });
    const sessionC = await auth.login({
      username: 'expiry.user',
      password: 'expiry password value',
      clientIp: '10.0.0.1',
    });

    const initialStoredA = await prisma.staffSession.findFirstOrThrow({
      where: {
        credentialDigest: createHash('sha256')
          .update(sessionA.rawSessionCredential)
          .digest('hex'),
      },
    });

    // Touching advances lastSeenAt without extending absoluteExpiresAt.
    clock.advanceMs(20 * 60_000);
    const nonTouching = await auth.resolveSession(
      sessionA.rawSessionCredential,
      {
        touch: false,
      },
    );
    expect(nonTouching?.user.id).toBe(staff.id);
    const afterNonTouch = await prisma.staffSession.findUniqueOrThrow({
      where: { id: initialStoredA.id },
    });
    expect(afterNonTouch.lastSeenAt).toEqual(initialStoredA.lastSeenAt);

    const touched = await auth.resolveSession(sessionA.rawSessionCredential);
    expect(touched?.user.id).toBe(staff.id);
    const afterTouch = await prisma.staffSession.findUniqueOrThrow({
      where: { id: initialStoredA.id },
    });
    expect(afterTouch.lastSeenAt).toEqual(clock.now());
    expect(afterTouch.absoluteExpiresAt).toEqual(
      initialStoredA.absoluteExpiresAt,
    );

    // Logout removes only sessionC, keeping sessionA & sessionB valid.
    const resolvedC = await auth.resolveSession(sessionC.rawSessionCredential);
    expect(resolvedC).not.toBeNull();
    await auth.logout(resolvedC!);
    expect(await auth.resolveSession(sessionC.rawSessionCredential)).toBeNull();
    expect(
      await prisma.staffSession.findUnique({
        where: { id: resolvedC!.sessionId },
      }),
    ).toBeNull();
    expect(
      await auth.resolveSession(sessionA.rawSessionCredential),
    ).not.toBeNull();

    // Session B was never touched after t=0; at t=+30m it hits idle expiry.
    clock.set(new Date('2026-11-20T08:30:00.000Z'));
    expect(await auth.resolveSession(sessionB.rawSessionCredential)).toBeNull();

    // Keep touching session A periodically up to just before 24h absolute expiry, then verify absolute expiry.
    let step = new Date('2026-11-20T08:45:00.000Z').getTime();
    const absoluteEnd = initialStoredA.absoluteExpiresAt.getTime();
    while (step < absoluteEnd) {
      clock.set(new Date(step));
      const ok = await auth.resolveSession(sessionA.rawSessionCredential);
      expect(ok).not.toBeNull();
      step += 20 * 60_000;
    }

    clock.set(initialStoredA.absoluteExpiresAt);
    expect(await auth.resolveSession(sessionA.rawSessionCredential)).toBeNull();
    expect(
      await prisma.staffSession.findUnique({
        where: { id: initialStoredA.id },
      }),
    ).toBeNull();

    // Resolving a session after authVersion mismatch or deactivation deletes the stale session and returns null.
    const freshForInvalidation = await auth.login({
      username: 'expiry.user',
      password: 'expiry password value',
      clientIp: '10.0.0.1',
    });
    const fakeStaleSession = await prisma.staffSession.create({
      data: {
        staffUserId: staff.id,
        credentialDigest: createHash('sha256')
          .update('manual-stale-token')
          .digest('hex'),
        authVersion: 99,
        csrfSecret: randomBytes(32).toString('base64url'),
        createdAt: clock.now(),
        lastSeenAt: clock.now(),
        absoluteExpiresAt: new Date(clock.now().getTime() + 60 * 60_000),
      },
    });
    expect(await auth.resolveSession('manual-stale-token')).toBeNull();
    expect(
      await prisma.staffSession.findUnique({
        where: { id: fakeStaleSession.id },
      }),
    ).toBeNull();
    expect(
      await auth.resolveSession(freshForInvalidation.rawSessionCredential),
    ).not.toBeNull();
  });

  it('prevents stale session issuance when login races operator resetPassword or deactivate', async () => {
    const resetTarget = await accounts.provision(
      { attribution: 'race operator' },
      {
        username: 'race.login.reset',
        fullName: 'Race Login Reset',
        password: 'initial password value',
      },
    );

    const resetEnteredVerify = deferred();
    const resetProceed = deferred();
    const resetAuth = createAuthService({
      verifier: async (hash, plain) => {
        const ok = await verifyPassword(hash, plain);
        resetEnteredVerify.resolve();
        await resetProceed.promise;
        return ok;
      },
    });

    const loginPromise = resetAuth.login({
      username: 'race.login.reset',
      password: 'initial password value',
      clientIp: '10.0.0.5',
    });
    await resetEnteredVerify.promise;

    await accounts.resetPassword(
      { attribution: 'race operator' },
      {
        id: resetTarget.id,
        expectedVersion: 1,
        password: 'operator reset password',
      },
    );
    resetProceed.resolve();

    await expect(loginPromise).rejects.toMatchObject({
      status: 401,
      code: ERROR_CODES.UNAUTHENTICATED,
      message: 'Invalid username or password',
    });
    expect(
      await prisma.staffSession.count({
        where: { staffUserId: resetTarget.id },
      }),
    ).toBe(0);
    expect(
      await prisma.changeHistory.count({
        where: { recordId: resetTarget.id, action: 'SIGN_IN_FAILED' },
      }),
    ).toBe(1);

    // Repeat the same deterministic race against operator deactivation.
    const deactivateTarget = await accounts.provision(
      { attribution: 'race operator' },
      {
        username: 'race.login.deactivate',
        fullName: 'Race Login Deactivate',
        password: 'initial password value',
      },
    );
    const deactivateEnteredVerify = deferred();
    const deactivateProceed = deferred();
    const deactivateAuth = createAuthService({
      verifier: async (hash, plain) => {
        const ok = await verifyPassword(hash, plain);
        deactivateEnteredVerify.resolve();
        await deactivateProceed.promise;
        return ok;
      },
    });

    const loginDeactivatePromise = deactivateAuth.login({
      username: 'race.login.deactivate',
      password: 'initial password value',
      clientIp: '10.0.0.6',
    });
    await deactivateEnteredVerify.promise;

    await accounts.deactivate(
      { attribution: 'race operator' },
      { id: deactivateTarget.id, expectedVersion: 1 },
    );
    deactivateProceed.resolve();

    await expect(loginDeactivatePromise).rejects.toMatchObject({
      status: 401,
      code: ERROR_CODES.UNAUTHENTICATED,
      message: 'Invalid username or password',
    });
    expect(
      await prisma.staffSession.count({
        where: { staffUserId: deactivateTarget.id },
      }),
    ).toBe(0);

    // Live concurrent race without injected barrier never leaves a stale authVersion session.
    const liveTarget = await accounts.provision(
      { attribution: 'race operator' },
      {
        username: 'race.login.live',
        fullName: 'Race Login Live',
        password: 'initial live password',
      },
    );
    const liveAuth = createAuthService();
    await Promise.allSettled([
      liveAuth.login({
        username: 'race.login.live',
        password: 'initial live password',
        clientIp: '10.0.0.7',
      }),
      accounts.resetPassword(
        { attribution: 'race operator' },
        {
          id: liveTarget.id,
          expectedVersion: 1,
          password: 'updated live password',
        },
      ),
    ]);
    const liveUser = await prisma.staffUser.findUniqueOrThrow({
      where: { id: liveTarget.id },
    });
    const staleSessions = await prisma.staffSession.count({
      where: {
        staffUserId: liveTarget.id,
        authVersion: { not: liveUser.authVersion },
      },
    });
    expect(staleSessions).toBe(0);
  });

  it('changes passwords with version check, invalidates all sessions, and resists reset races', async () => {
    const auth = createAuthService();
    const staff = await accounts.provision(
      { attribution: 'password operator' },
      {
        username: 'change.pass.user',
        fullName: 'Change Pass User',
        password: 'original staff password',
      },
    );

    const login1 = await auth.login({
      username: 'change.pass.user',
      password: 'original staff password',
      clientIp: '10.0.0.10',
    });
    const login2 = await auth.login({
      username: 'change.pass.user',
      password: 'original staff password',
      clientIp: '10.0.0.11',
    });
    const session1 = (await auth.resolveSession(login1.rawSessionCredential))!;

    await expect(
      auth.changePassword(session1, {
        expectedVersion: 1,
        currentPassword: 'original staff password',
        newPassword: 'too-short',
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: ERROR_CODES.VALIDATION_ERROR,
    });

    await expect(
      auth.changePassword(session1, {
        expectedVersion: 1,
        currentPassword: 'wrong current password',
        newPassword: 'replacement staff password',
      }),
    ).rejects.toMatchObject({
      status: 401,
      code: ERROR_CODES.UNAUTHENTICATED,
    });
    expect(
      await auth.resolveSession(login1.rawSessionCredential),
    ).not.toBeNull();

    await expect(
      auth.changePassword(session1, {
        expectedVersion: 99,
        currentPassword: 'original staff password',
        newPassword: 'replacement staff password',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: ERROR_CODES.STALE_VERSION,
    });

    const updated = await auth.changePassword(session1, {
      expectedVersion: 1,
      currentPassword: 'original staff password',
      newPassword: 'replacement staff password',
    });
    expect(updated.version).toBe(2);
    expect(updated).not.toHaveProperty('passwordHash');
    expect(
      await prisma.staffSession.count({ where: { staffUserId: staff.id } }),
    ).toBe(0);
    expect(await auth.resolveSession(login1.rawSessionCredential)).toBeNull();
    expect(await auth.resolveSession(login2.rawSessionCredential)).toBeNull();

    const storedAfter = await prisma.staffUser.findUniqueOrThrow({
      where: { id: staff.id },
    });
    expect(storedAfter.authVersion).toBe(2);
    expect(
      await verify(storedAfter.passwordHash, 'replacement staff password'),
    ).toBe(true);

    const history = await prisma.changeHistory.findMany({
      where: { recordId: staff.id, action: 'PASSWORD_CHANGED' },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      recordType: 'STAFF_USER',
      recordId: staff.id,
      action: 'PASSWORD_CHANGED',
      actorKind: 'STAFF',
      staffUserId: staff.id,
      operatorAttribution: null,
      before: staff,
      after: updated,
    });
    expect(JSON.stringify(history)).not.toContain('original staff password');
    expect(JSON.stringify(history)).not.toContain('replacement staff password');

    // Race changePassword against operator resetPassword after verification outside tx.
    const freshLogin = await auth.login({
      username: 'change.pass.user',
      password: 'replacement staff password',
      clientIp: '10.0.0.12',
    });
    const freshSession = (await auth.resolveSession(
      freshLogin.rawSessionCredential,
    ))!;

    const enteredVerify = deferred();
    const allowChangeTx = deferred();
    const racingAuth = createAuthService({
      verifier: async (hash, plain) => {
        const ok = await verifyPassword(hash, plain);
        enteredVerify.resolve();
        await allowChangeTx.promise;
        return ok;
      },
    });

    const changePromise = racingAuth.changePassword(freshSession, {
      expectedVersion: 2,
      currentPassword: 'replacement staff password',
      newPassword: 'staff race password',
    });
    await enteredVerify.promise;

    await accounts.resetPassword(
      { attribution: 'race operator' },
      {
        id: staff.id,
        expectedVersion: 2,
        password: 'operator won password',
      },
    );
    allowChangeTx.resolve();

    await expect(changePromise).rejects.toMatchObject({
      status: 401,
      code: ERROR_CODES.UNAUTHENTICATED,
    });
    const finalStored = await prisma.staffUser.findUniqueOrThrow({
      where: { id: staff.id },
    });
    expect(
      await verify(finalStored.passwordHash, 'operator won password'),
    ).toBe(true);
  });

  it('cleans up expired/revoked sessions via library and built CLI under runtime role', async () => {
    const activeUser = await accounts.provision(
      { attribution: 'cleanup operator' },
      {
        username: 'cleanup.active',
        fullName: 'Cleanup Active',
        password: 'cleanup active password',
      },
    );
    const deactivatedUser = await accounts.provision(
      { attribution: 'cleanup operator' },
      {
        username: 'cleanup.deactivated',
        fullName: 'Cleanup Deactivated',
        password: 'cleanup deactivated pass',
      },
    );
    await accounts.deactivate(
      { attribution: 'cleanup operator' },
      { id: deactivatedUser.id, expectedVersion: 1 },
    );

    // Clear existing sessions from previous tests so counts are deterministic.
    await prisma.staffSession.deleteMany();

    const now = new Date('2026-11-20T16:00:00.000Z');
    const makeDigest = () => randomBytes(32).toString('hex');
    const makeCsrf = () => randomBytes(32).toString('base64url');

    const validSession = await prisma.staffSession.create({
      data: {
        staffUserId: activeUser.id,
        credentialDigest: makeDigest(),
        authVersion: 1,
        csrfSecret: makeCsrf(),
        createdAt: new Date(now.getTime() - 10 * 60_000),
        lastSeenAt: new Date(now.getTime() - 5 * 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 60 * 60_000),
      },
    });
    // Idle-expired
    await prisma.staffSession.create({
      data: {
        staffUserId: activeUser.id,
        credentialDigest: makeDigest(),
        authVersion: 1,
        csrfSecret: makeCsrf(),
        createdAt: new Date(now.getTime() - 200 * 60_000),
        lastSeenAt: new Date(now.getTime() - 120 * 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 60 * 60_000),
      },
    });
    // Absolute-expired
    await prisma.staffSession.create({
      data: {
        staffUserId: activeUser.id,
        credentialDigest: makeDigest(),
        authVersion: 1,
        csrfSecret: makeCsrf(),
        createdAt: new Date(now.getTime() - 200 * 60_000),
        lastSeenAt: new Date(now.getTime() - 60_000),
        absoluteExpiresAt: now,
      },
    });
    // Stale authVersion
    await prisma.staffSession.create({
      data: {
        staffUserId: activeUser.id,
        credentialDigest: makeDigest(),
        authVersion: 99,
        csrfSecret: makeCsrf(),
        createdAt: new Date(now.getTime() - 5 * 60_000),
        lastSeenAt: new Date(now.getTime() - 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 60 * 60_000),
      },
    });
    // Deactivated user
    await prisma.staffSession.create({
      data: {
        staffUserId: deactivatedUser.id,
        credentialDigest: makeDigest(),
        authVersion: 2,
        csrfSecret: makeCsrf(),
        createdAt: new Date(now.getTime() - 5 * 60_000),
        lastSeenAt: new Date(now.getTime() - 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 60 * 60_000),
      },
    });

    const cleanupResult = await cleanupExpiredSessions(prisma, 120, now);
    expect(cleanupResult).toEqual({ deletedCount: 4 });
    const remaining = await prisma.staffSession.findMany();
    expect(remaining.map((row) => row.id)).toEqual([validSession.id]);

    // Clear all rows and insert one expired session relative to wall-clock time for the built CLI.
    await prisma.staffSession.deleteMany();
    const wallNow = new Date();
    await prisma.staffSession.create({
      data: {
        staffUserId: activeUser.id,
        credentialDigest: makeDigest(),
        authVersion: 1,
        csrfSecret: makeCsrf(),
        createdAt: new Date(wallNow.getTime() - 10_000),
        lastSeenAt: new Date(wallNow.getTime() - 10_000),
        absoluteExpiresAt: new Date(wallNow.getTime() - 1_000),
      },
    });

    const build = await child('npm', ['run', 'build']);
    expect(build.code).toBe(0);

    const cliOk = await child(
      process.execPath,
      ['dist/staff-access/session-cleanup-main.js'],
      '',
      database.runtimeUrl,
    );
    expect(cliOk.code).toBe(0);
    expect(cliOk.stderr).toBe('');
    expect(JSON.parse(cliOk.stdout)).toEqual({ data: { deletedCount: 1 } });

    const cliOwner = await child(
      process.execPath,
      ['dist/staff-access/session-cleanup-main.js'],
      '',
      database.url,
    );
    expect(cliOwner.code).toBe(1);
    expect(cliOwner.stdout).toBe('');
    expect(cliOwner.stderr).toContain(ERROR_CODES.OPERATOR_COMMAND_FAILED);
    expect(cliOwner.stderr).not.toContain(database.url);
  });
});

function child(
  command: string,
  args: string[],
  input = '',
  databaseUrl?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env: {
        ...process.env,
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.once('error', reject);
    proc.once('close', (code) => resolve({ code, stdout, stderr }));
    proc.stdin.end(input);
  });
}
