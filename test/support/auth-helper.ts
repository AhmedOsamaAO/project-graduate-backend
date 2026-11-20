import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { StaffAccountView } from '../../src/change-history/change-history';
import { PrismaService } from '../../src/prisma/prisma.service';
import { StaffAccounts } from '../../src/staff-access/staff-accounts';

export interface SignedInStaff {
  readonly user: StaffAccountView;
  readonly sessionCookie: string;
  readonly csrfToken: string;
  readonly origin: string;
}

export interface ProvisionAndLoginOptions {
  readonly username?: string;
  readonly fullName?: string;
  readonly password?: string;
  readonly origin?: string;
  readonly secureCookies?: boolean;
}

export function findSetCookieHeader(
  headers: string | string[] | undefined,
  cookieName: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const list = Array.isArray(headers) ? headers : [headers];
  const prefix = `${cookieName}=`;
  return list.find((entry) => entry.startsWith(prefix));
}

export function cookiePairFromSetCookie(header: string): string {
  const semi = header.indexOf(';');
  return semi === -1 ? header : header.slice(0, semi);
}

export async function provisionAndLogin<T extends App>(
  app: INestApplication<T>,
  options: ProvisionAndLoginOptions = {},
): Promise<SignedInStaff> {
  const username = options.username ?? 'e2e.staff';
  const fullName = options.fullName ?? 'E2E Staff';
  const password = options.password ?? 'e2e staff valid password';
  const origin = options.origin ?? 'http://localhost:5173';
  const csrfCookieName = options.secureCookies
    ? '__Host-graduate_csrf'
    : 'graduate_csrf';
  const sessionCookieName = options.secureCookies
    ? '__Host-graduate_session'
    : 'graduate_session';

  const accounts = new StaffAccounts(app.get(PrismaService));
  await accounts.provision(
    { attribution: 'e2e test harness' },
    { username, fullName, password },
  );

  const csrfResponse = await request(app.getHttpServer())
    .get('/api/v1/auth/csrf')
    .expect(200);
  const csrfHeader = findSetCookieHeader(
    csrfResponse.headers['set-cookie'],
    csrfCookieName,
  );
  if (!csrfHeader) {
    throw new Error(
      `Missing ${csrfCookieName} cookie on GET /api/v1/auth/csrf`,
    );
  }
  const preLoginCsrfToken = (
    csrfResponse.body as { data: { csrfToken: string } }
  ).data.csrfToken;

  const loginResponse = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .set('Cookie', cookiePairFromSetCookie(csrfHeader))
    .set('X-CSRF-Token', preLoginCsrfToken)
    .send({ username, password })
    .expect(200);

  const sessionHeader = findSetCookieHeader(
    loginResponse.headers['set-cookie'],
    sessionCookieName,
  );
  if (!sessionHeader) {
    throw new Error(
      `Missing ${sessionCookieName} cookie on POST /api/v1/auth/login`,
    );
  }
  const body = loginResponse.body as {
    data: { user: StaffAccountView; csrfToken: string };
  };

  return {
    user: body.data.user,
    sessionCookie: cookiePairFromSetCookie(sessionHeader),
    csrfToken: body.data.csrfToken,
    origin,
  };
}
