import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest, type Server } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { loadAppConfig } from '../src/config/app-config';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createTestEnvironment,
  type TestEnvironment,
} from './support/test-environment';

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

const requestStarted = deferred();
const requestReleased = deferred();
const shutdownEvents: string[] = [];

@Controller('__probe')
class SlowProbeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('slow')
  async slow(): Promise<{ databaseAvailable: boolean }> {
    requestStarted.resolve();
    await requestReleased.promise;
    await this.prisma.$queryRaw`SELECT 1`;
    shutdownEvents.push('request-completed');
    return { databaseAvailable: true };
  }
}

function get(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        agent: false,
        headers: { connection: 'close' },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function acceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitUntilRefusingConnections(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (!(await acceptsConnections(port))) {
      return;
    }
    await delay(10);
  }

  throw new Error('The server kept admitting connections after close()');
}

describe('graceful shutdown (e2e)', () => {
  let app: INestApplication<Server>;
  let environment: TestEnvironment;
  let closed = false;

  beforeAll(async () => {
    environment = await createTestEnvironment();
    const config = loadAppConfig();

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule.register(config)],
      controllers: [SlowProbeController],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApplication(app, config);
    await app.init();
  });

  afterAll(async () => {
    requestReleased.resolve();
    if (app && !closed) {
      await app.close();
    }
    if (environment) {
      await environment.close();
    }
  });

  it('drains in-flight requests with a working database after it stops admitting new ones', async () => {
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port');
    }
    const { port } = address;

    // Prisma reconnects lazily, so a query after $disconnect() would still
    // succeed. Record when the disconnect happens instead.
    const prisma = app.get(PrismaService);
    const disconnect = prisma.$disconnect.bind(prisma) as () => Promise<void>;
    jest.spyOn(prisma, '$disconnect').mockImplementation(async () => {
      shutdownEvents.push('database-disconnected');
      await disconnect();
    });

    const inFlight = get(port, '/api/v1/__probe/slow');
    await requestStarted.promise;

    const closing = app.close();
    closed = true;

    // Once connections are refused the shutdown has passed every module
    // destroy hook; the in-flight request must still be running and finish
    // before the database connection is closed.
    await waitUntilRefusingConnections(port);
    requestReleased.resolve();

    const response = await inFlight;
    await closing;

    expect(shutdownEvents).toEqual([
      'request-completed',
      'database-disconnected',
    ]);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      data: { databaseAvailable: true },
    });
    await expect(get(port, '/api/v1')).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });
});
