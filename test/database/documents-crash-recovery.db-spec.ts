import { PrismaPg } from '@prisma/adapter-pg';
import type { INestApplication } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createApplication } from '../../src/bootstrap';
import { ChangeHistoryService } from '../../src/change-history/change-history.service';
import { ERROR_CODES } from '../../src/common/errors/error-codes';
import type { FileOperationFaultCutPoint } from '../../src/documents/file-operation-executor';
import {
  DocumentType,
  FileOperationKind,
  FileOperationStatus,
  PrismaClient,
} from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  csrfCookieName as resolveCsrfCookieName,
  sessionCookieName as resolveSessionCookieName,
} from '../../src/staff-access/cookies';
import { StaffAccounts } from '../../src/staff-access/staff-accounts';
import { StudentArchiveGuardRegistry } from '../../src/students/student-archive-guard';
import { StudentsService } from '../../src/students/students.service';
import {
  cookiePairFromSetCookie,
  findSetCookieHeader,
  type SignedInStaff,
} from '../support/auth-helper';
import { buildValidPdf, captureBinaryBody } from '../support/document-fixtures';
import {
  createTestEnvironment,
  type TestEnvironment,
} from '../support/test-environment';

interface WorkerExitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

function spawnCrashWorker(env: NodeJS.ProcessEnv): Promise<WorkerExitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-r',
        './test/support/ts-node-prisma-loader.cjs',
        'test/support/crash-upload-worker.ts',
      ],
      {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output }));
  });
}

async function loginExistingStaff<T extends App>(
  app: INestApplication<T>,
  username: string,
  password: string,
): Promise<SignedInStaff> {
  const origin = 'http://localhost:5173';
  const cookieConfig = { cookieSecure: false };
  const csrfCookieName = resolveCsrfCookieName(cookieConfig);
  const sessionCookieName = resolveSessionCookieName(cookieConfig);

  const csrfResponse = await request(app.getHttpServer())
    .get('/api/v1/auth/csrf')
    .expect(200);
  const csrfHeader = findSetCookieHeader(
    csrfResponse.headers['set-cookie'],
    csrfCookieName,
  );
  if (!csrfHeader) {
    throw new Error(`Missing ${csrfCookieName} cookie`);
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
    throw new Error(`Missing ${sessionCookieName} cookie`);
  }
  const body = loginResponse.body as {
    data: {
      user: SignedInStaff['user'];
      csrfToken: string;
    };
  };

  return {
    user: body.data.user,
    sessionCookie: cookiePairFromSetCookie(sessionHeader),
    csrfToken: body.data.csrfToken,
    origin,
  };
}

describe('document upload process-crash recovery across all cut points (db)', () => {
  interface CrashCaseSpec {
    readonly cutPoint: FileOperationFaultCutPoint;
    readonly payloadMode: 'valid-pdf' | 'invalid-pdf';
    readonly expectedPreRestartStagingCount: number;
    readonly expectedPreRestartObjectsCount: number;
    readonly expectedPreRestartStatus: FileOperationStatus;
    readonly expectedFailureStatus: number;
    readonly expectedFailureCode: string;
  }

  const interruptedCases: readonly CrashCaseSpec[] = [
    {
      cutPoint: 'AFTER_ADMIT',
      payloadMode: 'valid-pdf',
      expectedPreRestartStagingCount: 0,
      expectedPreRestartObjectsCount: 0,
      expectedPreRestartStatus: FileOperationStatus.IN_PROGRESS,
      expectedFailureStatus: 409,
      expectedFailureCode: ERROR_CODES.UPLOAD_INTERRUPTED,
    },
    {
      cutPoint: 'AFTER_STAGING_WRITE',
      payloadMode: 'valid-pdf',
      expectedPreRestartStagingCount: 1,
      expectedPreRestartObjectsCount: 0,
      expectedPreRestartStatus: FileOperationStatus.IN_PROGRESS,
      expectedFailureStatus: 409,
      expectedFailureCode: ERROR_CODES.UPLOAD_INTERRUPTED,
    },
    {
      cutPoint: 'AFTER_PREPARE_BEFORE_PUBLISH',
      payloadMode: 'valid-pdf',
      expectedPreRestartStagingCount: 0,
      expectedPreRestartObjectsCount: 1,
      expectedPreRestartStatus: FileOperationStatus.IN_PROGRESS,
      expectedFailureStatus: 409,
      expectedFailureCode: ERROR_CODES.UPLOAD_INTERRUPTED,
    },
    {
      cutPoint: 'AFTER_CLEANUP_CLAIM_BEFORE_UNLINK',
      payloadMode: 'invalid-pdf',
      expectedPreRestartStagingCount: 1,
      expectedPreRestartObjectsCount: 0,
      expectedPreRestartStatus: FileOperationStatus.CLEANUP_PENDING,
      expectedFailureStatus: 400,
      expectedFailureCode: ERROR_CODES.UNSUPPORTED_FILE_FORMAT,
    },
  ];

  it.each(interruptedCases)(
    'reconciles SIGKILL at $cutPoint without auto-publishing and reclaims all disk artifacts on restart',
    async (spec) => {
      const env: TestEnvironment = await createTestEnvironment();
      let app: INestApplication<App> | undefined;

      try {
        const username = 'crash.recovery.staff';
        const password = 'crash recovery valid password';
        const idempotencyKey = `crash-${spec.cutPoint.toLowerCase()}`;

        const setupPrisma = new PrismaClient({
          adapter: new PrismaPg({ connectionString: env.database.runtimeUrl }),
        });
        let staffUserId: number;
        let studentId: number;
        try {
          const staff = await new StaffAccounts(setupPrisma).provision(
            { attribution: 'crash test' },
            { username, fullName: 'Crash Staff', password },
          );
          const students = new StudentsService(
            setupPrisma as unknown as PrismaService,
            new ChangeHistoryService(setupPrisma as unknown as PrismaService),
            new StudentArchiveGuardRegistry(),
          );
          const student = await students.createStudent(
            { staffUserId: staff.id },
            { fullName: 'Crash Test Student', nationalId: '29601011234567' },
          );
          staffUserId = staff.id;
          studentId = student.id;
        } finally {
          await setupPrisma.$disconnect();
        }

        const workerExit = await spawnCrashWorker({
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: env.database.runtimeUrl,
          PRIVATE_STORAGE_ROOT: env.storage.path,
          CRASH_CUT_POINT: spec.cutPoint,
          WORKER_STAFF_USER_ID: String(staffUserId),
          WORKER_STUDENT_ID: String(studentId),
          WORKER_IDEMPOTENCY_KEY: idempotencyKey,
          WORKER_PAYLOAD_MODE: spec.payloadMode,
        });
        expect({
          signal: workerExit.signal,
          code: workerExit.code,
          output: workerExit.signal === 'SIGKILL' ? '' : workerExit.output,
        }).toEqual({
          signal: 'SIGKILL',
          code: null,
          output: '',
        });

        // Inspect pre-restart state BEFORE booting fresh app
        const inspectPrisma = new PrismaClient({
          adapter: new PrismaPg({ connectionString: env.database.runtimeUrl }),
        });
        try {
          expect(
            await inspectPrisma.document.count({ where: { studentId } }),
          ).toBe(0);
          const preOp = await inspectPrisma.fileOperation.findUniqueOrThrow({
            where: {
              requestedByStaffUserId_kind_idempotencyKey: {
                requestedByStaffUserId: staffUserId,
                kind: FileOperationKind.UPLOAD,
                idempotencyKey,
              },
            },
          });
          expect(preOp.status).toBe(spec.expectedPreRestartStatus);
          expect(await readdir(join(env.storage.path, 'staging'))).toHaveLength(
            spec.expectedPreRestartStagingCount,
          );
          expect(await readdir(join(env.storage.path, 'objects'))).toHaveLength(
            spec.expectedPreRestartObjectsCount,
          );
        } finally {
          await inspectPrisma.$disconnect();
        }

        // Boot fresh app (runs FileOperationExecutor.onModuleInit startup reconciliation)
        app = (await createApplication()) as INestApplication<App>;
        const signedIn = await loginExistingStaff(app, username, password);

        // Verify disk artifacts reclaimed and zero docs published
        expect(await readdir(join(env.storage.path, 'staging'))).toEqual([]);
        expect(await readdir(join(env.storage.path, 'objects'))).toEqual([]);
        const postDocList = await request(app.getHttpServer())
          .get(`/api/v1/students/${studentId}/documents`)
          .set('Cookie', signedIn.sessionCookie)
          .expect(200);
        expect((postDocList.body as { items: unknown[] }).items).toEqual([]);

        // Verify sanitized FileOperation status via by-key lookup
        const opRes = await request(app.getHttpServer())
          .get('/api/v1/file-operations/by-key')
          .query({ kind: FileOperationKind.UPLOAD, idempotencyKey })
          .set('Cookie', signedIn.sessionCookie)
          .expect(200);
        const opBody = (opRes.body as { data: Record<string, unknown> }).data;
        expect(opBody).toMatchObject({
          kind: FileOperationKind.UPLOAD,
          status: FileOperationStatus.FAILED,
          studentId,
          documentId: null,
          failureCode: spec.expectedFailureCode,
        });
        expect(opBody).not.toHaveProperty('storageKey');
        expect(opBody).not.toHaveProperty('stagingKey');
        expect(opBody).not.toHaveProperty('claimToken');
        expect(opBody).not.toHaveProperty('executorId');
        expect(opBody).not.toHaveProperty('requestFingerprint');
        expect(JSON.stringify(opRes.body)).not.toContain(env.storage.path);

        // Retrying the exact same upload with the same Idempotency-Key returns recorded failure
        const retryBytes =
          spec.payloadMode === 'invalid-pdf'
            ? Buffer.from('not a real pdf payload', 'utf8')
            : buildValidPdf('Crash Worker Upload');
        const retryFileName =
          spec.payloadMode === 'invalid-pdf' ? 'spoof.pdf' : 'transcript.pdf';

        const retryRes = await request(app.getHttpServer())
          .post(`/api/v1/students/${studentId}/documents`)
          .set('Origin', signedIn.origin)
          .set('Cookie', signedIn.sessionCookie)
          .set('X-CSRF-Token', signedIn.csrfToken)
          .set('Idempotency-Key', idempotencyKey)
          .field('documentType', DocumentType.TRANSCRIPT)
          .attach('file', retryBytes, {
            filename: retryFileName,
            contentType: 'application/pdf',
          })
          .expect(spec.expectedFailureStatus);
        expect((retryRes.body as { code: string }).code).toBe(
          spec.expectedFailureCode,
        );

        // Fresh upload with a new key succeeds cleanly
        const validPdf = buildValidPdf('Fresh After Recovery');
        const freshRes = await request(app.getHttpServer())
          .post(`/api/v1/students/${studentId}/documents`)
          .set('Origin', signedIn.origin)
          .set('Cookie', signedIn.sessionCookie)
          .set('X-CSRF-Token', signedIn.csrfToken)
          .set('Idempotency-Key', `${idempotencyKey}-fresh`)
          .field('documentType', DocumentType.TRANSCRIPT)
          .attach('file', validPdf, {
            filename: 'recovered-transcript.pdf',
            contentType: 'application/pdf',
          })
          .expect(201);
        const createdDoc = (freshRes.body as { data: { id: number } }).data;

        const dlRes = await request(app.getHttpServer())
          .get(`/api/v1/documents/${createdDoc.id}/download`)
          .set('Cookie', signedIn.sessionCookie)
          .buffer(true)
          .parse(captureBinaryBody)
          .expect(200);
        expect(dlRes.body).toEqual(validPdf);
      } finally {
        if (app) {
          await app.close();
        }
        await env.close();
      }
    },
  );

  it('preserves committed document on SIGKILL at AFTER_PUBLISH_BEFORE_RESPONSE and replays idempotently without duplicates', async () => {
    const env: TestEnvironment = await createTestEnvironment();
    let app: INestApplication<App> | undefined;

    try {
      const username = 'crash.publish.staff';
      const password = 'crash publish valid password';
      const idempotencyKey = 'crash-after-publish-key';
      const pdfBytes = buildValidPdf('Crash Worker Upload');

      const setupPrisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: env.database.runtimeUrl }),
      });
      let staffUserId: number;
      let studentId: number;
      try {
        const staff = await new StaffAccounts(setupPrisma).provision(
          { attribution: 'crash publish test' },
          { username, fullName: 'Crash Publish Staff', password },
        );
        const students = new StudentsService(
          setupPrisma as unknown as PrismaService,
          new ChangeHistoryService(setupPrisma as unknown as PrismaService),
          new StudentArchiveGuardRegistry(),
        );
        const student = await students.createStudent(
          { staffUserId: staff.id },
          { fullName: 'Crash Publish Student', nationalId: '29602021234567' },
        );
        staffUserId = staff.id;
        studentId = student.id;
      } finally {
        await setupPrisma.$disconnect();
      }

      const workerExit = await spawnCrashWorker({
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: env.database.runtimeUrl,
        PRIVATE_STORAGE_ROOT: env.storage.path,
        CRASH_CUT_POINT: 'AFTER_PUBLISH_BEFORE_RESPONSE',
        WORKER_STAFF_USER_ID: String(staffUserId),
        WORKER_STUDENT_ID: String(studentId),
        WORKER_IDEMPOTENCY_KEY: idempotencyKey,
        WORKER_PAYLOAD_MODE: 'valid-pdf',
      });
      expect(workerExit.signal).toBe('SIGKILL');
      expect(workerExit.code).toBeNull();

      let committedDocumentId: number;
      const inspectPrisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: env.database.runtimeUrl }),
      });
      try {
        const docs = await inspectPrisma.document.findMany({
          where: { studentId },
        });
        expect(docs).toHaveLength(1);
        committedDocumentId = docs[0].id;
        const preOp = await inspectPrisma.fileOperation.findUniqueOrThrow({
          where: {
            requestedByStaffUserId_kind_idempotencyKey: {
              requestedByStaffUserId: staffUserId,
              kind: FileOperationKind.UPLOAD,
              idempotencyKey,
            },
          },
        });
        expect(preOp.status).toBe(FileOperationStatus.COMPLETED);
        expect(preOp.documentId).toBe(committedDocumentId);
        expect(await readdir(join(env.storage.path, 'staging'))).toEqual([]);
        expect(await readdir(join(env.storage.path, 'objects'))).toHaveLength(
          1,
        );
      } finally {
        await inspectPrisma.$disconnect();
      }

      app = (await createApplication()) as INestApplication<App>;
      const signedIn = await loginExistingStaff(app, username, password);

      const opRes = await request(app.getHttpServer())
        .get('/api/v1/file-operations/by-key')
        .query({ kind: FileOperationKind.UPLOAD, idempotencyKey })
        .set('Cookie', signedIn.sessionCookie)
        .expect(200);
      expect(
        (opRes.body as { data: Record<string, unknown> }).data,
      ).toMatchObject({
        status: FileOperationStatus.COMPLETED,
        documentId: committedDocumentId,
        failureCode: null,
      });

      const dlRes = await request(app.getHttpServer())
        .get(`/api/v1/documents/${committedDocumentId}/download`)
        .set('Cookie', signedIn.sessionCookie)
        .buffer(true)
        .parse(captureBinaryBody)
        .expect(200);
      expect(dlRes.body).toEqual(pdfBytes);

      // Client retry after lost HTTP response replays the same document cleanly
      const replayRes = await request(app.getHttpServer())
        .post(`/api/v1/students/${studentId}/documents`)
        .set('Origin', signedIn.origin)
        .set('Cookie', signedIn.sessionCookie)
        .set('X-CSRF-Token', signedIn.csrfToken)
        .set('Idempotency-Key', idempotencyKey)
        .field('documentType', DocumentType.TRANSCRIPT)
        .attach('file', pdfBytes, {
          filename: 'transcript.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      expect(replayRes.headers['x-file-operation-id']).toMatch(/^\d+$/);
      expect((replayRes.body as { data: { id: number } }).data.id).toBe(
        committedDocumentId,
      );

      // Verify zero duplicate documents, history rows, or stored objects
      const afterPrisma = app.get(PrismaService);
      expect(await afterPrisma.document.count({ where: { studentId } })).toBe(
        1,
      );
      expect(
        await afterPrisma.changeHistory.count({
          where: { recordType: 'DOCUMENT', recordId: committedDocumentId },
        }),
      ).toBe(1);
      expect(await readdir(join(env.storage.path, 'objects'))).toHaveLength(1);
    } finally {
      if (app) {
        await app.close();
      }
      await env.close();
    }
  });
});
