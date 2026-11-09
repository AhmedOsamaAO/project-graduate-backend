import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Express } from 'express';
import { AppModule } from './app.module';
import { ApiError } from './common/errors/api-error';
import { ERROR_CODES } from './common/errors/error-codes';
import { flattenValidationErrors } from './common/errors/validation-details';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/http/response-envelope.interceptor';
import { loadAppConfig, type AppConfig } from './config/app-config';
import { loadEnvironment } from './config/load-environment';

export interface CreateApplicationOptions {
  readonly config?: AppConfig;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The one bootstrap path shared by the production entry point and E2E tests.
 */
export async function createApplication(
  options: CreateApplicationOptions = {},
): Promise<INestApplication> {
  const config = resolveConfiguration(options);
  const app = await NestFactory.create(AppModule.register(config));

  try {
    configureApplication(app, config);
    await app.init();
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Applies the HTTP surface, security defaults, and OpenAPI document to an
 * already-created Nest application. Exported so integration tests can add
 * probe controllers while exercising the same setup.
 */
export function configureApplication(
  app: INestApplication,
  config: AppConfig,
): void {
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  app.enableCors({
    origin: [...config.frontendOrigins],
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      exceptionFactory: (errors) =>
        new ApiError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'Validation failed',
          flattenValidationErrors(errors),
        ),
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());

  const server = app.getHttpAdapter().getInstance() as Express;
  server.disable('x-powered-by');
  server.set(
    'trust proxy',
    config.environment === 'production' ? 'loopback' : false,
  );

  setupOpenApi(app);
}

function resolveConfiguration(options: CreateApplicationOptions): AppConfig {
  if (options.config) {
    return options.config;
  }

  if (options.env) {
    return loadAppConfig(options.env);
  }

  loadEnvironment();
  return loadAppConfig();
}

function setupOpenApi(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Faculty Postgraduate Records API')
      .setDescription(
        'Staff-operated API for the Computer and Information faculty postgraduate office.',
      )
      .setVersion('1.0')
      .addServer('/')
      .build(),
    {
      operationIdFactory: (controllerKey, methodKey) =>
        `${controllerKey}_${methodKey}`,
    },
  );

  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    swaggerOptions: { persistAuthorization: true },
  });
}
