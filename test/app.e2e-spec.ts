import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import {
  createTestEnvironment,
  type TestEnvironment,
} from './support/test-environment';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  let environment: TestEnvironment;

  beforeAll(async () => {
    environment = await createTestEnvironment();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (environment) {
      await environment.close();
    }
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('uses the disposable test database', async () => {
    const prisma = app.get(PrismaService);
    const [{ currentDatabase }] = await prisma.$queryRaw<
      Array<{ currentDatabase: string }>
    >`SELECT current_database() AS "currentDatabase"`;

    expect(currentDatabase).toBe(environment.database.name);
  });
});
