import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createApplication } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';
import { provisionAndLogin, type SignedInStaff } from './support/auth-helper';
import {
  createTestEnvironment,
  type TestEnvironment,
} from './support/test-environment';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  let environment: TestEnvironment;
  let staff: SignedInStaff;

  beforeAll(async () => {
    environment = await createTestEnvironment();
    app = (await createApplication()) as INestApplication<App>;
    staff = await provisionAndLogin(app, { username: 'app.e2e.staff' });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (environment) {
      await environment.close();
    }
  });

  it('/api/v1 (GET) denies unauthenticated callers', () => {
    return request(app.getHttpServer()).get('/api/v1').expect(401).expect({
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
  });

  it('/api/v1 (GET) returns the single-resource envelope for authenticated staff', () => {
    return request(app.getHttpServer())
      .get('/api/v1')
      .set('Cookie', staff.sessionCookie)
      .expect(200)
      .expect({ data: { message: 'Hello World!' } });
  });

  it('uses the disposable test database', async () => {
    const prisma = app.get(PrismaService);
    const [{ currentDatabase }] = await prisma.$queryRaw<
      Array<{ currentDatabase: string }>
    >`SELECT current_database() AS "currentDatabase"`;

    expect(currentDatabase).toBe(environment.database.name);
  });
});
