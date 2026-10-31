import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createApplication } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createTestEnvironment,
  type TestEnvironment,
} from './support/test-environment';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  let environment: TestEnvironment;

  beforeAll(async () => {
    environment = await createTestEnvironment();
    app = (await createApplication()) as INestApplication<App>;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (environment) {
      await environment.close();
    }
  });

  it('/api/v1 (GET) returns the single-resource envelope', () => {
    return request(app.getHttpServer())
      .get('/api/v1')
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
