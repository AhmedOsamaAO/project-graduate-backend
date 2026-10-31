import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  INestApplication,
  NotFoundException,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsNotEmpty, IsString } from 'class-validator';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import type { ErrorEnvelope } from '../src/common/errors/error-codes';
import { createPage, type PageResult } from '../src/common/http/page';
import { PageQueryDto } from '../src/common/http/page-query.dto';
import { loadAppConfig } from '../src/config/app-config';
import {
  createTestEnvironment,
  type TestEnvironment,
} from './support/test-environment';

interface OpenApiDocument {
  paths: Record<string, { get?: { responses: Record<string, unknown> } }>;
  components: { schemas: Record<string, unknown> };
}

class EchoQueryDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}

@Controller('__probe')
class ProbeController {
  @Get('validation')
  validation(@Query() query: EchoQueryDto): EchoQueryDto {
    return query;
  }

  @Get('page')
  page() {
    return createPage([{ id: 1, name: 'record' }], 1, 1, 20);
  }

  @Get('page-query')
  pageQuery(@Query() query: PageQueryDto): PageQueryDto {
    return query;
  }

  @Get('unauthenticated')
  unauthenticated(): never {
    throw new UnauthorizedException();
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException();
  }

  @Get('not-found')
  notFound(): never {
    throw new NotFoundException();
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException();
  }

  @Get('bad-request')
  badRequest(): never {
    throw new HttpException('raw parser output from body', 400);
  }

  @Post('echo')
  echo(@Body() body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }

  @Get('rate-limited')
  rateLimited(): never {
    throw new HttpException('Slow down', 429);
  }

  @Get('unavailable')
  unavailable(): never {
    throw new HttpException('raw storage path /srv/private', 503);
  }

  @Get('http-500')
  http500(): never {
    throw new HttpException('raw database SELECT * FROM students', 500);
  }

  @Get('unexpected')
  unexpected(): never {
    throw new Error(
      'nationalId=12345678901234 password=super-secret SELECT * FROM students',
    );
  }
}

describe('platform foundation (e2e)', () => {
  let app: INestApplication<App>;
  let environment: TestEnvironment;

  beforeAll(async () => {
    environment = await createTestEnvironment();
    const config = loadAppConfig();

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule.register(config)],
      controllers: [ProbeController],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApplication(app, config);
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

  it('wraps single resources in the data envelope', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1')
      .expect(200);

    expect(response.body).toEqual({ data: { message: 'Hello World!' } });
  });

  it('returns the page envelope unchanged', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/__probe/page')
      .expect(200);
    const body = response.body as PageResult<unknown>;

    expect(body).toEqual({
      items: [{ id: 1, name: 'record' }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
  });

  it('applies the default page size and rejects values over the maximum', async () => {
    const defaults = await request(app.getHttpServer())
      .get('/api/v1/__probe/page-query')
      .expect(200);
    const defaultBody = defaults.body as { data: PageQueryDto };

    expect(defaultBody.data).toMatchObject({ page: 1, pageSize: 20 });

    await request(app.getHttpServer())
      .get('/api/v1/__probe/page-query?page=2&pageSize=100')
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/__probe/page-query?pageSize=101')
      .expect(400);

    await request(app.getHttpServer())
      .get('/api/v1/__probe/page-query?page=not-a-number')
      .expect(400);
  });

  it('rejects invalid and unknown request fields with field details', async () => {
    const missingResponse = await request(app.getHttpServer())
      .get('/api/v1/__probe/validation')
      .expect(400);
    const missing = missingResponse.body as ErrorEnvelope;

    expect(missing).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
    });
    expect(missing.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'name' })]),
    );

    const extraResponse = await request(app.getHttpServer())
      .get('/api/v1/__probe/validation?name=ok&extra=1')
      .expect(400);
    const extra = extraResponse.body as ErrorEnvelope;

    expect(extra).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
    });
    expect(extra.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'extra' })]),
    );
  });

  it.each([
    ['/api/v1/__probe/unauthenticated', 401, 'UNAUTHENTICATED'],
    ['/api/v1/__probe/forbidden', 403, 'FORBIDDEN'],
    ['/api/v1/__probe/not-found', 404, 'NOT_FOUND'],
    ['/api/v1/__probe/conflict', 409, 'CONFLICT'],
    ['/api/v1/__probe/rate-limited', 429, 'RATE_LIMITED'],
    ['/api/v1/__probe/unavailable', 503, 'SERVICE_UNAVAILABLE'],
  ])(
    'maps %s to status %i and code %s',
    async (path, expectedStatus, expectedCode) => {
      const response = await request(app.getHttpServer())
        .get(path)
        .expect(expectedStatus);
      const body = response.body as ErrorEnvelope;

      expect(body.code).toBe(expectedCode);
      expect(typeof body.message).toBe('string');
      expect(body).not.toHaveProperty('stack');
    },
  );

  it.each([
    ['/api/v1/__probe/bad-request', 400],
    ['/api/v1/__probe/http-500', 500],
    ['/api/v1/__probe/unexpected', 500],
    ['/api/v1/missing-route', 404],
  ])('never exposes raw errors from %s', async (path, expectedStatus) => {
    const response = await request(app.getHttpServer())
      .get(path)
      .expect(expectedStatus);
    const body = response.body as ErrorEnvelope;
    const serialized = JSON.stringify(body);

    expect(typeof body.code).toBe('string');
    expect(typeof body.message).toBe('string');
    expect(serialized).not.toContain('SELECT * FROM');
    expect(serialized).not.toContain('raw parser output');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('12345678901234');
    expect(serialized).not.toContain('/srv/private');
    expect(serialized).not.toContain('stack');
  });

  it('maps body-parser client faults to sanitized client errors', async () => {
    const tooLarge = await request(app.getHttpServer())
      .post('/api/v1/__probe/echo')
      .send({ padding: 'x'.repeat(200_000) })
      .expect(413);
    expect(tooLarge.body).toEqual({
      code: 'BAD_REQUEST',
      message: 'Request failed',
    });

    const unsupportedCharset = await request(app.getHttpServer())
      .post('/api/v1/__probe/echo')
      .set('Content-Type', 'application/json; charset=foo')
      .send('{}')
      .expect(415);
    expect(unsupportedCharset.body).toEqual({
      code: 'BAD_REQUEST',
      message: 'Request failed',
    });

    const malformed = await request(app.getHttpServer())
      .post('/api/v1/__probe/echo')
      .set('Content-Type', 'application/json')
      .send('{"broken"')
      .expect(400);
    expect(malformed.body).toEqual({
      code: 'BAD_REQUEST',
      message: 'Bad request',
    });
  });

  it('allows only exact configured frontend origins', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/api/v1')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await request(app.getHttpServer())
      .get('/api/v1')
      .set('Origin', 'http://untrusted.example')
      .expect(200);

    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not trust forwarded headers in test mode', () => {
    const server = app.getHttpAdapter().getInstance() as {
      get(setting: string): unknown;
    };
    expect(server.get('trust proxy')).toBe(false);
  });

  it('serves the OpenAPI document with the shared error contract', async () => {
    await request(app.getHttpServer()).get('/api/docs').expect(200);

    const response = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    const document = response.body as OpenApiDocument;

    const operation = document.paths['/api/v1']?.get;
    expect(operation).toBeDefined();

    const responses = operation?.responses ?? {};
    for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
      expect(responses[String(status)]).toBeDefined();
    }

    expect(document.components.schemas.ApiErrorDto).toBeDefined();
  });
});
