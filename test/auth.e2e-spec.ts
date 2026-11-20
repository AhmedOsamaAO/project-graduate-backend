import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApplication, createApplication } from '../src/bootstrap';
import {
  ERROR_CODES,
  type ErrorEnvelope,
} from '../src/common/errors/error-codes';
import { loadAppConfig } from '../src/config/app-config';
import { PrismaService } from '../src/prisma/prisma.service';
import { LOGIN_THROTTLER_OPTIONS } from '../src/staff-access/login-throttler';
import { SessionCleanupScheduler } from '../src/staff-access/session-cleanup.scheduler';
import { StaffAccounts } from '../src/staff-access/staff-accounts';
import { STAFF_AUTH_CLOCK } from '../src/staff-access/staff-auth.service';
import {
  cookiePairFromSetCookie,
  findSetCookieHeader,
} from './support/auth-helper';
import {
  createTestEnvironment,
  type TestEnvironment,
} from './support/test-environment';

class MutableClock {
  private current: Date;

  constructor(initial: Date) {
    this.current = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

interface OpenApiOperation {
  responses?: Record<string, unknown>;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
}

describe('staff authentication, sessions, and CSRF (e2e)', () => {
  describe('default application surface', () => {
    let app: INestApplication<App>;
    let environment: TestEnvironment;
    let prisma: PrismaService;
    let accounts: StaffAccounts;
    const origin = 'http://localhost:5173';

    beforeAll(async () => {
      environment = await createTestEnvironment();
      app = (await createApplication()) as INestApplication<App>;
      prisma = app.get(PrismaService);
      accounts = new StaffAccounts(prisma);
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
      if (environment) {
        await environment.close();
      }
    });

    async function getCsrf(): Promise<{
      cookiePair: string;
      rawHeader: string;
      csrfToken: string;
    }> {
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/csrf')
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const rawHeader = findSetCookieHeader(
        res.headers['set-cookie'],
        'graduate_csrf',
      );
      expect(rawHeader).toBeDefined();
      const csrfToken = (res.body as { data: { csrfToken: string } }).data
        .csrfToken;
      return {
        cookiePair: cookiePairFromSetCookie(rawHeader!),
        rawHeader: rawHeader!,
        csrfToken,
      };
    }

    it('enforces default-deny authentication on non-bootstrap routes', async () => {
      for (const makeRequest of [
        () => request(app.getHttpServer()).get('/api/v1'),
        () => request(app.getHttpServer()).get('/api/v1/auth/me'),
        () =>
          request(app.getHttpServer())
            .post('/api/v1/auth/logout')
            .set('Origin', origin),
        () =>
          request(app.getHttpServer())
            .post('/api/v1/auth/change-password')
            .set('Origin', origin)
            .send({
              expectedVersion: 1,
              currentPassword: 'any current password',
              newPassword: 'any replacement pass',
            }),
      ]) {
        const res = await makeRequest().expect(401);
        expect(res.body).toEqual({
          code: ERROR_CODES.UNAUTHENTICATED,
          message: 'Authentication required',
        });
      }
    });

    it('rejects using pre-login CSRF cookies to authenticate protected routes', async () => {
      const { cookiePair, rawHeader, csrfToken } = await getCsrf();
      expect(rawHeader).toContain('HttpOnly');
      expect(rawHeader).toContain('Path=/');
      expect(rawHeader).toContain('SameSite=Lax');
      expect(rawHeader).not.toContain('Domain=');
      expect(rawHeader).not.toContain('Secure');

      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', cookiePair)
        .expect(401);

      const csrfVal = cookiePair.split('=')[1];
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', `graduate_session=${csrfVal}`)
        .expect(401);

      await request(app.getHttpServer())
        .get('/api/v1')
        .set('Cookie', cookiePair)
        .set('X-CSRF-Token', csrfToken)
        .expect(401);
    });

    it('enforces exact Origin and CSRF token checks on login, logout, and change-password', async () => {
      const staff = await accounts.provision(
        { attribution: 'csrf e2e operator' },
        {
          username: 'csrf.e2e.user',
          fullName: 'CSRF E2E User',
          password: 'csrf e2e user password',
        },
      );
      const bootstrap = await getCsrf();

      // Missing Origin -> 403 ORIGIN_NOT_ALLOWED
      const noOrigin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Cookie', bootstrap.cookiePair)
        .set('X-CSRF-Token', bootstrap.csrfToken)
        .send({ username: staff.username, password: 'csrf e2e user password' })
        .expect(403);
      expect((noOrigin.body as ErrorEnvelope).code).toBe(
        ERROR_CODES.ORIGIN_NOT_ALLOWED,
      );

      // Untrusted / trailing-slash / null Origin -> 403 ORIGIN_NOT_ALLOWED
      for (const badOrigin of [
        'http://evil.example',
        'http://localhost:5173/',
        'http://localhost:51730',
        'null',
      ]) {
        const bad = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('Origin', badOrigin)
          .set('Cookie', bootstrap.cookiePair)
          .set('X-CSRF-Token', bootstrap.csrfToken)
          .send({
            username: staff.username,
            password: 'csrf e2e user password',
          })
          .expect(403);
        expect((bad.body as ErrorEnvelope).code).toBe(
          ERROR_CODES.ORIGIN_NOT_ALLOWED,
        );
      }

      // Missing or wrong CSRF -> 403 CSRF_INVALID
      for (const makeRequest of [
        () =>
          request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .set('Origin', origin)
            .send({
              username: staff.username,
              password: 'csrf e2e user password',
            }),
        () =>
          request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .set('Origin', origin)
            .set('Cookie', bootstrap.cookiePair)
            .send({
              username: staff.username,
              password: 'csrf e2e user password',
            }),
        () =>
          request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .set('Origin', origin)
            .set('Cookie', bootstrap.cookiePair)
            .set('X-CSRF-Token', 'wrong-csrf-token')
            .send({
              username: staff.username,
              password: 'csrf e2e user password',
            }),
      ]) {
        const res = await makeRequest().expect(403);
        expect((res.body as ErrorEnvelope).code).toBe(ERROR_CODES.CSRF_INVALID);
      }

      // Successful login issues fresh session & CSRF tokens, clears pre-login CSRF cookie
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .set('Cookie', bootstrap.cookiePair)
        .set('X-CSRF-Token', bootstrap.csrfToken)
        .send({ username: staff.username, password: 'csrf e2e user password' })
        .expect(200);
      expect(loginRes.headers['cache-control']).toBe('no-store');

      const sessionSetCookie = findSetCookieHeader(
        loginRes.headers['set-cookie'],
        'graduate_session',
      );
      const clearedCsrfSetCookie = findSetCookieHeader(
        loginRes.headers['set-cookie'],
        'graduate_csrf',
      );
      expect(sessionSetCookie).toBeDefined();
      expect(sessionSetCookie).toContain('HttpOnly');
      expect(sessionSetCookie).toContain('Path=/');
      expect(sessionSetCookie).toContain('SameSite=Lax');
      expect(sessionSetCookie).not.toContain('Domain=');
      expect(clearedCsrfSetCookie).toMatch(
        /Expires=Thu, 01 Jan 1970|Max-Age=0/,
      );

      const sessionPair = cookiePairFromSetCookie(sessionSetCookie!);
      const loginData = (
        loginRes.body as {
          data: { user: typeof staff; csrfToken: string };
        }
      ).data;
      expect(loginData.user).toEqual(staff);
      expect(loginData.csrfToken).not.toBe(bootstrap.csrfToken);
      expect(loginData.csrfToken).not.toBe(sessionPair.split('=')[1]);

      // Consumed pre-login CSRF state cannot be replayed on login.
      const replayRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .set('Cookie', bootstrap.cookiePair)
        .set('X-CSRF-Token', bootstrap.csrfToken)
        .send({ username: staff.username, password: 'csrf e2e user password' })
        .expect(403);
      expect((replayRes.body as ErrorEnvelope).code).toBe(
        ERROR_CODES.CSRF_INVALID,
      );

      // Authenticated GET /auth/csrf returns active session CSRF without touching lastSeenAt.
      const beforeCsrf = await prisma.staffSession.findFirstOrThrow({
        where: { staffUserId: staff.id },
      });
      const authCsrfRes = await request(app.getHttpServer())
        .get('/api/v1/auth/csrf')
        .set('Cookie', sessionPair)
        .expect(200);
      expect(
        (authCsrfRes.body as { data: { csrfToken: string } }).data.csrfToken,
      ).toBe(loginData.csrfToken);
      expect(
        findSetCookieHeader(authCsrfRes.headers['set-cookie'], 'graduate_csrf'),
      ).toBeUndefined();
      const afterCsrf = await prisma.staffSession.findUniqueOrThrow({
        where: { id: beforeCsrf.id },
      });
      expect(afterCsrf.lastSeenAt).toEqual(beforeCsrf.lastSeenAt);

      // Authenticated GET /auth/csrf clears any leftover pre-login CSRF cookie.
      const staleCsrfRes = await request(app.getHttpServer())
        .get('/api/v1/auth/csrf')
        .set('Cookie', `${sessionPair}; graduate_csrf=stale-leftover`)
        .expect(200);
      expect(
        (staleCsrfRes.body as { data: { csrfToken: string } }).data.csrfToken,
      ).toBe(loginData.csrfToken);
      expect(
        findSetCookieHeader(
          staleCsrfRes.headers['set-cookie'],
          'graduate_csrf',
        ),
      ).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);

      // GET /auth/me returns user and csrfToken.
      const meRes = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', sessionPair)
        .expect(200);
      expect(meRes.headers['cache-control']).toBe('no-store');
      expect(meRes.body).toEqual({
        data: { user: staff, csrfToken: loginData.csrfToken },
      });

      // Protected state-changing routes (change-password & logout) enforce Origin and CSRF.
      const cpBadOrigin = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', 'http://evil.example')
        .set('Cookie', sessionPair)
        .set('X-CSRF-Token', loginData.csrfToken)
        .send({
          expectedVersion: 1,
          currentPassword: 'csrf e2e user password',
          newPassword: 'replacement e2e password',
        })
        .expect(403);
      expect((cpBadOrigin.body as ErrorEnvelope).code).toBe(
        ERROR_CODES.ORIGIN_NOT_ALLOWED,
      );

      const cpBadCsrf = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', origin)
        .set('Cookie', sessionPair)
        .set('X-CSRF-Token', 'wrong-token')
        .send({
          expectedVersion: 1,
          currentPassword: 'csrf e2e user password',
          newPassword: 'replacement e2e password',
        })
        .expect(403);
      expect((cpBadCsrf.body as ErrorEnvelope).code).toBe(
        ERROR_CODES.CSRF_INVALID,
      );

      const logoutNoOrigin = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', sessionPair)
        .set('X-CSRF-Token', loginData.csrfToken)
        .expect(403);
      expect((logoutNoOrigin.body as ErrorEnvelope).code).toBe(
        ERROR_CODES.ORIGIN_NOT_ALLOWED,
      );

      const logoutBadCsrf = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', origin)
        .set('Cookie', sessionPair)
        .set('X-CSRF-Token', bootstrap.csrfToken)
        .expect(403);
      expect((logoutBadCsrf.body as ErrorEnvelope).code).toBe(
        ERROR_CODES.CSRF_INVALID,
      );

      // An already-authenticated caller with a leftover pre-login CSRF cookie can still re-login using their active session CSRF token.
      const reloginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .set('Cookie', `${sessionPair}; graduate_csrf=stale-leftover`)
        .set('X-CSRF-Token', loginData.csrfToken)
        .send({ username: staff.username, password: 'csrf e2e user password' })
        .expect(200);
      expect(
        findSetCookieHeader(reloginRes.headers['set-cookie'], 'graduate_csrf'),
      ).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
      expect(
        findSetCookieHeader(
          reloginRes.headers['set-cookie'],
          'graduate_session',
        ),
      ).toBeDefined();
    });

    it('returns identical generic login errors and records redacted SIGN_IN_FAILED history', async () => {
      await accounts.provision(
        { attribution: 'failure e2e operator' },
        {
          username: 'e2e.active.fail',
          fullName: 'Active Fail',
          password: 'active fail user password',
        },
      );
      const deactivated = await accounts.provision(
        { attribution: 'failure e2e operator' },
        {
          username: 'e2e.deactivated.fail',
          fullName: 'Deactivated Fail',
          password: 'deactivated fail password',
        },
      );
      await accounts.deactivate(
        { attribution: 'failure e2e operator' },
        { id: deactivated.id, expectedVersion: 1 },
      );

      const csrf = await getCsrf();
      for (const attempt of [
        { username: 'no.such.user', password: 'wrong-password-secret' },
        { username: 'e2e.active.fail', password: 'wrong-password-secret' },
        {
          username: 'e2e.deactivated.fail',
          password: 'deactivated fail password',
        },
      ]) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('Origin', origin)
          .set('Cookie', csrf.cookiePair)
          .set('X-CSRF-Token', csrf.csrfToken)
          .send(attempt)
          .expect(401);
        expect(res.body).toEqual({
          code: ERROR_CODES.UNAUTHENTICATED,
          message: 'Invalid username or password',
        });
      }

      const history = await prisma.changeHistory.findMany({
        where: { action: 'SIGN_IN_FAILED' },
      });
      expect(history.length).toBeGreaterThanOrEqual(3);
      const serialized = JSON.stringify(history);
      expect(serialized).not.toContain('no.such.user');
      expect(serialized).not.toContain('wrong-password-secret');
      expect(serialized).not.toContain('deactivated fail password');
    });

    it('supports single-session logout and all-session-invalidating password changes', async () => {
      const staff = await accounts.provision(
        { attribution: 'lifecycle e2e operator' },
        {
          username: 'lifecycle.user',
          fullName: 'Lifecycle User',
          password: 'initial lifecycle pass',
        },
      );

      const signIn = async (password: string) => {
        const csrf = await getCsrf();
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('Origin', origin)
          .set('Cookie', csrf.cookiePair)
          .set('X-CSRF-Token', csrf.csrfToken)
          .send({ username: staff.username, password })
          .expect(200);
        const cookie = cookiePairFromSetCookie(
          findSetCookieHeader(res.headers['set-cookie'], 'graduate_session')!,
        );
        const data = (res.body as { data: { csrfToken: string } }).data;
        return { cookie, csrfToken: data.csrfToken };
      };

      const session1 = await signIn('initial lifecycle pass');
      const session2 = await signIn('initial lifecycle pass');

      // Logout ends only session1.
      const logoutRes = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', origin)
        .set('Cookie', session1.cookie)
        .set('X-CSRF-Token', session1.csrfToken)
        .expect(204);
      expect(logoutRes.text).toBe('');
      expect(
        findSetCookieHeader(
          logoutRes.headers['set-cookie'],
          'graduate_session',
        ),
      ).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);

      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', session1.cookie)
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', session2.cookie)
        .expect(200);

      // Sign in again as session3 so two active sessions exist before change-password.
      const session3 = await signIn('initial lifecycle pass');

      // Missing expectedVersion -> 400
      await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', origin)
        .set('Cookie', session2.cookie)
        .set('X-CSRF-Token', session2.csrfToken)
        .send({
          currentPassword: 'initial lifecycle pass',
          newPassword: 'updated lifecycle pass',
        })
        .expect(400);

      // Short newPassword -> 400
      await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', origin)
        .set('Cookie', session2.cookie)
        .set('X-CSRF-Token', session2.csrfToken)
        .send({
          expectedVersion: 1,
          currentPassword: 'initial lifecycle pass',
          newPassword: 'short',
        })
        .expect(400);

      // Wrong currentPassword -> 401 without ending session2
      await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', origin)
        .set('Cookie', session2.cookie)
        .set('X-CSRF-Token', session2.csrfToken)
        .send({
          expectedVersion: 1,
          currentPassword: 'not the current pass',
          newPassword: 'updated lifecycle pass',
        })
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', session2.cookie)
        .expect(200);

      // Stale expectedVersion -> 409 STALE_VERSION
      const staleRes = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', origin)
        .set('Cookie', session2.cookie)
        .set('X-CSRF-Token', session2.csrfToken)
        .send({
          expectedVersion: 99,
          currentPassword: 'initial lifecycle pass',
          newPassword: 'updated lifecycle pass',
        })
        .expect(409);
      expect((staleRes.body as ErrorEnvelope).code).toBe(
        ERROR_CODES.STALE_VERSION,
      );

      // Valid change-password -> 200 DTO, clears cookie, invalidates all sessions.
      const changeRes = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', origin)
        .set('Cookie', session2.cookie)
        .set('X-CSRF-Token', session2.csrfToken)
        .send({
          expectedVersion: 1,
          currentPassword: 'initial lifecycle pass',
          newPassword: 'updated lifecycle pass',
        })
        .expect(200);
      expect(changeRes.headers['cache-control']).toBe('no-store');
      expect(
        findSetCookieHeader(
          changeRes.headers['set-cookie'],
          'graduate_session',
        ),
      ).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
      expect(changeRes.body).toMatchObject({
        data: {
          id: staff.id,
          username: staff.username,
          fullName: staff.fullName,
          deactivatedAt: null,
          version: 2,
          createdAt: staff.createdAt,
        },
      });
      expect(
        typeof (changeRes.body as { data: { updatedAt: unknown } }).data
          .updatedAt,
      ).toBe('string');
      expect(JSON.stringify(changeRes.body)).not.toContain('passwordHash');

      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', session2.cookie)
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', session3.cookie)
        .expect(401);

      const csrfAfter = await getCsrf();
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .set('Cookie', csrfAfter.cookiePair)
        .set('X-CSRF-Token', csrfAfter.csrfToken)
        .send({ username: staff.username, password: 'initial lifecycle pass' })
        .expect(401);

      await signIn('updated lifecycle pass');
    });

    it('runs the periodic cleanup sweep and documents all auth routes in OpenAPI', async () => {
      const user = await accounts.provision(
        { attribution: 'sweep e2e operator' },
        {
          username: 'sweep.user',
          fullName: 'Sweep User',
          password: 'sweep user password val',
        },
      );
      await prisma.staffSession.create({
        data: {
          staffUserId: user.id,
          credentialDigest: randomBytes(32).toString('hex'),
          authVersion: 1,
          csrfSecret: randomBytes(32).toString('base64url'),
          createdAt: new Date(Date.now() - 20_000),
          lastSeenAt: new Date(Date.now() - 20_000),
          absoluteExpiresAt: new Date(Date.now() - 5_000),
        },
      });

      const scheduler = app.get(SessionCleanupScheduler);
      await scheduler.runSweep();
      expect(
        await prisma.staffSession.count({ where: { staffUserId: user.id } }),
      ).toBe(0);

      const docsRes = await request(app.getHttpServer())
        .get('/api/docs-json')
        .expect(200);
      const doc = docsRes.body as OpenApiDocument;
      expect(doc.components.securitySchemes).toBeDefined();

      const expectedRoutes: ReadonlyArray<[string, 'get' | 'post']> = [
        ['/api/v1/auth/csrf', 'get'],
        ['/api/v1/auth/login', 'post'],
        ['/api/v1/auth/me', 'get'],
        ['/api/v1/auth/logout', 'post'],
        ['/api/v1/auth/change-password', 'post'],
      ];
      for (const [path, method] of expectedRoutes) {
        const op = doc.paths[path]?.[method];
        expect(op).toBeDefined();
        for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
          expect(op?.responses?.[String(status)]).toBeDefined();
        }
      }
    });
  });

  describe('production cookie security, throttling, and expiry rules', () => {
    let app: INestApplication<App>;
    let environment: TestEnvironment;
    let clock: MutableClock;
    const prodOrigin = 'https://records.example.edu';

    beforeAll(async () => {
      environment = await createTestEnvironment();
      clock = new MutableClock(new Date('2026-11-20T10:00:00.000Z'));
      const prodConfig = loadAppConfig({
        NODE_ENV: 'production',
        DATABASE_URL: environment.database.runtimeUrl,
        HOST: '127.0.0.1',
        PORT: '3000',
        FRONTEND_ORIGINS: prodOrigin,
        COOKIE_SECURE: 'true',
        CSRF_MODE: 'synchronizer',
        SESSION_IDLE_TIMEOUT_MINUTES: '120',
        SESSION_ABSOLUTE_TIMEOUT_DAYS: '7',
        SESSION_CLEANUP_INTERVAL_MINUTES: '15',
        PRIVATE_STORAGE_ROOT: environment.storage.path,
        UPLOAD_MAX_BYTES: '10485760',
      });

      const moduleFixture = await Test.createTestingModule({
        imports: [AppModule.register(prodConfig)],
      })
        .overrideProvider(STAFF_AUTH_CLOCK)
        .useValue(clock)
        .overrideProvider(LOGIN_THROTTLER_OPTIONS)
        .useValue({
          windowMs: 60_000,
          maxUsernameAttempts: 2,
          maxIpAttempts: 3,
        })
        .compile();

      app = moduleFixture.createNestApplication();
      configureApplication(app, prodConfig);
      await app.init();

      const accounts = new StaffAccounts(app.get(PrismaService));
      await accounts.provision(
        { attribution: 'prod e2e operator' },
        {
          username: 'prod.staff',
          fullName: 'Prod Staff',
          password: 'production staff pass',
        },
      );
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
      if (environment) {
        await environment.close();
      }
    });

    it('issues Secure __Host- host-only cookies and enforces temporary IP/username throttling behind loopback proxy', async () => {
      const server = app.getHttpAdapter().getInstance() as {
        get(setting: string): unknown;
      };
      expect(server.get('trust proxy')).toBe('loopback');

      const csrfRes = await request(app.getHttpServer())
        .get('/api/v1/auth/csrf')
        .expect(200);
      const csrfHeader = findSetCookieHeader(
        csrfRes.headers['set-cookie'],
        '__Host-graduate_csrf',
      );
      expect(csrfHeader).toBeDefined();
      expect(csrfHeader).toContain('HttpOnly');
      expect(csrfHeader).toContain('Secure');
      expect(csrfHeader).toContain('Path=/');
      expect(csrfHeader).toContain('SameSite=Lax');
      expect(csrfHeader).not.toContain('Domain=');
      const csrfPair = cookiePairFromSetCookie(csrfHeader!);
      const csrfToken = (csrfRes.body as { data: { csrfToken: string } }).data
        .csrfToken;

      // Two failures for prod.staff across distinct forwarded IPs trigger username throttle.
      for (const ip of ['203.0.113.10', '203.0.113.11']) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('Origin', prodOrigin)
          .set('X-Forwarded-For', ip)
          .set('Cookie', csrfPair)
          .set('X-CSRF-Token', csrfToken)
          .send({ username: 'prod.staff', password: 'wrong password value' })
          .expect(401);
      }

      const usernameBlocked = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', prodOrigin)
        .set('X-Forwarded-For', '203.0.113.12')
        .set('Cookie', csrfPair)
        .set('X-CSRF-Token', csrfToken)
        .send({ username: 'prod.staff', password: 'production staff pass' })
        .expect(429);
      expect((usernameBlocked.body as ErrorEnvelope).code).toBe(
        ERROR_CODES.RATE_LIMITED,
      );
      expect(Number(usernameBlocked.headers['retry-after'])).toBeGreaterThan(0);

      // Three failures from one forwarded IP across distinct usernames trigger IP throttle.
      for (const username of ['nobody.1', 'nobody.2', 'nobody.3']) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('Origin', prodOrigin)
          .set('X-Forwarded-For', '198.51.100.50')
          .set('Cookie', csrfPair)
          .set('X-CSRF-Token', csrfToken)
          .send({ username, password: 'wrong password value' })
          .expect(401);
      }

      const ipBlocked = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', prodOrigin)
        .set('X-Forwarded-For', '198.51.100.50')
        .set('Cookie', csrfPair)
        .set('X-CSRF-Token', csrfToken)
        .send({ username: 'nobody.4', password: 'wrong password value' })
        .expect(429);
      expect((ipBlocked.body as ErrorEnvelope).code).toBe(
        ERROR_CODES.RATE_LIMITED,
      );
      expect(Number(ipBlocked.headers['retry-after'])).toBeGreaterThan(0);

      // Advance past the throttle window -> no permanent lockout; valid credentials succeed with __Host- session cookie.
      clock.advanceMs(61_000);
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', prodOrigin)
        .set('X-Forwarded-For', '198.51.100.50')
        .set('Cookie', csrfPair)
        .set('X-CSRF-Token', csrfToken)
        .send({ username: 'prod.staff', password: 'production staff pass' })
        .expect(200);

      const sessionHeader = findSetCookieHeader(
        loginRes.headers['set-cookie'],
        '__Host-graduate_session',
      );
      expect(sessionHeader).toBeDefined();
      expect(sessionHeader).toContain('HttpOnly');
      expect(sessionHeader).toContain('Secure');
      expect(sessionHeader).toContain('Path=/');
      expect(sessionHeader).toContain('SameSite=Lax');
      expect(sessionHeader).not.toContain('Domain=');
      expect(
        findSetCookieHeader(
          loginRes.headers['set-cookie'],
          '__Host-graduate_csrf',
        ),
      ).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);

      const sessionPair = cookiePairFromSetCookie(sessionHeader!);
      const prodSessionBefore = await app
        .get(PrismaService)
        .staffSession.findFirstOrThrow({ orderBy: { id: 'desc' } });

      // Rejected 403 state-changing requests (bad Origin / invalid CSRF) must not extend lastSeenAt.
      clock.advanceMs(5 * 60_000);
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', sessionPair)
        .set('X-CSRF-Token', 'invalid-csrf')
        .expect(403);
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', prodOrigin)
        .set('Cookie', sessionPair)
        .set('X-CSRF-Token', 'invalid-csrf')
        .expect(403);
      const prodSessionAfter = await app
        .get(PrismaService)
        .staffSession.findUniqueOrThrow({
          where: { id: prodSessionBefore.id },
        });
      expect(prodSessionAfter.lastSeenAt).toEqual(prodSessionBefore.lastSeenAt);

      // Verify idle expiry (2 hours) and absolute expiry (7 days) over HTTP.
      clock.advanceMs(114 * 60_000);
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', sessionPair)
        .expect(200);

      clock.advanceMs(120 * 60_000);
      const idleExpired = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', sessionPair)
        .expect(401);
      expect(
        findSetCookieHeader(
          idleExpired.headers['set-cookie'],
          '__Host-graduate_session',
        ),
      ).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);

      // Re-login and keep touching every 90 minutes until the 7-day absolute cap expires the session.
      const csrf2Res = await request(app.getHttpServer())
        .get('/api/v1/auth/csrf')
        .expect(200);
      const csrf2Pair = cookiePairFromSetCookie(
        findSetCookieHeader(
          csrf2Res.headers['set-cookie'],
          '__Host-graduate_csrf',
        )!,
      );
      const csrf2Token = (csrf2Res.body as { data: { csrfToken: string } }).data
        .csrfToken;

      const login2Res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', prodOrigin)
        .set('Cookie', csrf2Pair)
        .set('X-CSRF-Token', csrf2Token)
        .send({ username: 'prod.staff', password: 'production staff pass' })
        .expect(200);
      const session2Pair = cookiePairFromSetCookie(
        findSetCookieHeader(
          login2Res.headers['set-cookie'],
          '__Host-graduate_session',
        )!,
      );

      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const stepMs = 90 * 60_000;
      for (let elapsed = stepMs; elapsed < sevenDaysMs; elapsed += stepMs) {
        clock.advanceMs(stepMs);
        await request(app.getHttpServer())
          .get('/api/v1/auth/me')
          .set('Cookie', session2Pair)
          .expect(200);
      }

      clock.advanceMs(stepMs);
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', session2Pair)
        .expect(401);
    });
  });
});
