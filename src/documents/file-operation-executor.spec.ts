import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../config/app-config';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  AcademicRank,
  DocumentAvailability,
  DocumentType,
  ExternalApprovalStatus,
  FileOperationKind,
  FileOperationStatus,
  Prisma,
  SupervisorAffiliation,
  type Document,
  type FileOperation,
  type Student,
  type StudentQualification,
  type Supervisor,
} from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { StudentArchiveGuardRegistry } from '../students/student-archive-guard';
import { StudentsService } from '../students/students.service';
import { ChangeHistoryService } from '../change-history/change-history.service';
import {
  FileOperationExecutor,
  type FileOperationFaultHook,
} from './file-operation-executor';
import {
  createBufferUploadSource,
  createSupervisorBufferUploadSource,
} from './multipart-upload';
import { PrivateFileStorage } from './private-file-storage';

function buildMinimalPdf(): Buffer {
  const header = '%PDF-1.4\n';
  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n';
  const xrefOffset = Buffer.byteLength(header + obj1 + obj2, 'ascii');
  const xref =
    'xref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n';
  const trailer = `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(header + obj1 + obj2 + xref + trailer, 'ascii');
}

function createConfig(root: string): AppConfig {
  return {
    environment: 'test',
    isProduction: false,
    databaseUrl: 'postgresql://user:pass@localhost:5432/db',
    port: 3000,
    host: '127.0.0.1',
    frontendOrigins: ['http://localhost:5173'],
    cookieSecure: false,
    csrfMode: 'synchronizer',
    sessionIdleTimeoutMinutes: 120,
    sessionAbsoluteTimeoutDays: 7,
    sessionCleanupIntervalMinutes: 15,
    privateStorageRoot: root,
    uploadMaxBytes: 1024 * 1024,
    fileOperationReconciliationIntervalSeconds: 60,
    fileOperationLeaseSeconds: 120,
  };
}

function adapterError(code: string) {
  return Object.assign(new Error(`DB ${code}`), {
    cause: { originalCode: code },
  });
}

function createFakeExecutorPrisma(initialNow: Date) {
  let tick = 0;
  const nextTime = () => new Date(initialNow.getTime() + ++tick * 100);

  let state = {
    students: [
      {
        id: 1,
        fullName: 'Active Student',
        nationalId: '29901011234567',
        phone: null,
        birthDate: null,
        address: null,
        militaryStatus: null,
        selectedPhotoDocumentId: null,
        archivedAt: null,
        version: 1,
        createdAt: initialNow,
        updatedAt: initialNow,
      } satisfies Student,
    ],
    supervisors: [
      {
        id: 1,
        fullName: 'Dr. External Supervisor',
        academicRank: AcademicRank.PROFESSOR,
        affiliation: SupervisorAffiliation.EXTERNAL,
        departmentId: null,
        workplace: 'Cairo University',
        phone: null,
        email: null,
        nationalId: null,
        externalApprovalStatus: ExternalApprovalStatus.PENDING,
        externalRejectionReason: null,
        deactivatedAt: null,
        version: 1,
        createdAt: initialNow,
        updatedAt: initialNow,
      } satisfies Supervisor,
    ],
    qualifications: [] as StudentQualification[],
    documents: [] as Document[],
    fileOperations: [] as FileOperation[],
    history: [] as Array<Record<string, unknown>>,
    nextDocumentId: 1,
    nextOperationId: 1,
    nextHistoryId: 1,
  };

  let failNextPublishWith: Error | null = null;
  let onPublishTransactionStart: (() => Promise<void>) | null = null;

  const makeClient = (getState: () => typeof state) => ({
    $queryRaw: () => Promise.resolve([]),
    student: {
      findUnique: ({ where }: { where: { id: number } }) => {
        const row = getState().students.find((s) => s.id === where.id);
        return Promise.resolve(row ? structuredClone(row) : null);
      },
    },
    supervisor: {
      findUnique: ({ where }: { where: { id: number } }) => {
        const row = getState().supervisors.find((s) => s.id === where.id);
        return Promise.resolve(row ? structuredClone(row) : null);
      },
    },
    studentQualification: {
      findUnique: ({ where }: { where: { id: number } }) => {
        const row = getState().qualifications.find((q) => q.id === where.id);
        return Promise.resolve(row ? structuredClone(row) : null);
      },
    },
    document: {
      findUnique: ({
        where,
      }: {
        where: { id?: number; storageKey?: string };
      }) => {
        const row = getState().documents.find((d) =>
          where.id !== undefined
            ? d.id === where.id
            : d.storageKey === where.storageKey,
        );
        return Promise.resolve(row ? structuredClone(row) : null);
      },
      create: ({ data }: { data: Record<string, unknown> }) => {
        const working = getState();
        const now = nextTime();
        const doc: Document = {
          id: working.nextDocumentId++,
          studentId: (data.studentId as number | null) ?? null,
          supervisorId: (data.supervisorId as number | null) ?? null,
          qualificationId: (data.qualificationId as number | null) ?? null,
          documentType: data.documentType as DocumentType,
          description: (data.description as string | null) ?? null,
          originalFileName: data.originalFileName as string,
          storageKey: data.storageKey as string,
          mimeType: data.mimeType as string,
          byteSize: data.byteSize as number,
          uploadedAt: (data.uploadedAt as Date) ?? now,
          archivedAt: null,
          availability: DocumentAvailability.AVAILABLE,
          deletedAt: null,
          deletedByStaffUserId: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        working.documents.push(doc);
        return Promise.resolve(structuredClone(doc));
      },
    },
    fileOperation: {
      findUnique: ({
        where,
      }: {
        where: {
          id?: number;
          requestedByStaffUserId_kind_idempotencyKey?: {
            requestedByStaffUserId: number;
            kind: FileOperationKind;
            idempotencyKey: string;
          };
        };
      }) => {
        const row = getState().fileOperations.find((op) => {
          if (where.id !== undefined) {
            return op.id === where.id;
          }
          const key = where.requestedByStaffUserId_kind_idempotencyKey!;
          return (
            op.requestedByStaffUserId === key.requestedByStaffUserId &&
            op.kind === key.kind &&
            op.idempotencyKey === key.idempotencyKey
          );
        });
        return Promise.resolve(row ? structuredClone(row) : null);
      },
      findMany: ({ where }: { where?: Record<string, unknown> } = {}) => {
        const rows = getState().fileOperations.filter((op) => {
          if (!where) return true;
          if (where.kind && op.kind !== where.kind) return false;
          if (
            where.status &&
            typeof where.status === 'object' &&
            'in' in where.status &&
            !(where.status as { in: FileOperationStatus[] }).in.includes(
              op.status,
            )
          ) {
            return false;
          }
          return true;
        });
        return Promise.resolve(rows.map((r) => structuredClone(r)));
      },
      create: ({ data }: { data: Record<string, unknown> }) => {
        const working = getState();
        const dup = working.fileOperations.some(
          (op) =>
            op.requestedByStaffUserId === data.requestedByStaffUserId &&
            op.kind === data.kind &&
            op.idempotencyKey === data.idempotencyKey,
        );
        if (dup) {
          return Promise.reject(adapterError('23505'));
        }
        const now = nextTime();
        const op: FileOperation = {
          id: working.nextOperationId++,
          kind: data.kind as FileOperationKind,
          status:
            (data.status as FileOperationStatus) ??
            FileOperationStatus.IN_PROGRESS,
          requestedByStaffUserId: data.requestedByStaffUserId as number,
          studentId: (data.studentId as number | null) ?? null,
          supervisorId: (data.supervisorId as number | null) ?? null,
          documentId: (data.documentId as number | null) ?? null,
          idempotencyKey: data.idempotencyKey as string,
          requestFingerprint:
            (data.requestFingerprint as string | null) ?? null,
          stagingKey: (data.stagingKey as string | null) ?? null,
          storageKey: data.storageKey as string,
          executorId: (data.executorId as string | null) ?? null,
          claimToken: (data.claimToken as string | null) ?? null,
          leaseExpiresAt: (data.leaseExpiresAt as Date | null) ?? null,
          errorStatus: (data.errorStatus as number | null) ?? null,
          errorCode: (data.errorCode as string | null) ?? null,
          errorMessage: (data.errorMessage as string | null) ?? null,
          createdAt: now,
          updatedAt: now,
          completedAt: (data.completedAt as Date | null) ?? null,
        };
        working.fileOperations.push(op);
        return Promise.resolve(structuredClone(op));
      },
      update: ({
        where,
        data,
      }: {
        where: { id: number };
        data: Record<string, unknown>;
      }) => {
        const working = getState();
        const idx = working.fileOperations.findIndex((o) => o.id === where.id);
        if (idx === -1) {
          return Promise.reject(new Error('Missing fileOperation'));
        }
        const current = working.fileOperations[idx];
        const updated: FileOperation = Object.assign(
          structuredClone(current),
          data,
          { updatedAt: nextTime() },
        );
        working.fileOperations[idx] = updated;
        return Promise.resolve(structuredClone(updated));
      },
      updateMany: ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const working = getState();
        let count = 0;
        for (let i = 0; i < working.fileOperations.length; i += 1) {
          const op = working.fileOperations[i];
          if (where.id !== undefined && op.id !== where.id) continue;
          if (where.status !== undefined && op.status !== where.status)
            continue;
          if (
            where.claimToken !== undefined &&
            op.claimToken !== where.claimToken
          ) {
            continue;
          }
          working.fileOperations[i] = Object.assign(structuredClone(op), data, {
            updatedAt: nextTime(),
          });
          count += 1;
        }
        return Promise.resolve({ count });
      },
    },
    changeHistory: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        const working = getState();
        working.history.push({ id: working.nextHistoryId++, ...data });
        return Promise.resolve({});
      },
    },
  });

  const root = makeClient(() => state);
  const prisma = {
    ...root,
    $transaction: async <T>(
      arg: (tx: Prisma.TransactionClient) => Promise<T>,
    ) => {
      if (onPublishTransactionStart) {
        const hook = onPublishTransactionStart;
        onPublishTransactionStart = null;
        await hook();
      }
      if (failNextPublishWith) {
        const err = failNextPublishWith;
        failNextPublishWith = null;
        throw err;
      }
      const draft = structuredClone(state);
      const tx = makeClient(() => draft) as unknown as Prisma.TransactionClient;
      const result = await arg(tx);
      state = draft;
      return result;
    },
  } as unknown as PrismaService;

  return {
    prisma,
    getState: () => state,
    setFailNextPublishWith: (error: Error) => {
      failNextPublishWith = error;
    },
    setOnNextTransactionStart: (hook: () => Promise<void>) => {
      onPublishTransactionStart = hook;
    },
  };
}

describe('FileOperationExecutor', () => {
  const actor = { staffUserId: 10 };
  let storageRoot: string;
  let now: Date;
  let fakeDb: ReturnType<typeof createFakeExecutorPrisma>;
  let storage: PrivateFileStorage;
  let executor: FileOperationExecutor;
  let faultHook: FileOperationFaultHook;

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'file-op-executor-spec-'));
    now = new Date('2026-11-28T10:00:00.000Z');
    fakeDb = createFakeExecutorPrisma(now);
    const config = createConfig(storageRoot);
    storage = new PrivateFileStorage(config);
    const historyService = new ChangeHistoryService(fakeDb.prisma);
    const studentsService = new StudentsService(
      fakeDb.prisma,
      historyService,
      new StudentArchiveGuardRegistry(),
    );
    faultHook = { onCutPoint: () => undefined };
    executor = new FileOperationExecutor(
      fakeDb.prisma,
      config,
      storage,
      studentsService,
      { now: () => now },
      faultHook,
    );
    await executor.onModuleInit();
  });

  afterEach(async () => {
    await executor.onModuleDestroy();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('publishes valid uploads atomically, returns existing outcome on idempotent retry, and rejects key conflicts', async () => {
    const pdf = buildMinimalPdf();
    const first = await executor.executeStudentUpload(
      actor,
      1,
      'upload-key-1',
      createBufferUploadSource({
        documentType: DocumentType.TRANSCRIPT,
        originalFileName: 'transcript.pdf',
        content: pdf,
      }),
    );

    expect(first.kind).toBe('COMPLETED');
    if (first.kind !== 'COMPLETED') throw new Error('expected completed');
    expect(first.document.originalFileName).toBe('transcript.pdf');
    expect(first.document).not.toHaveProperty('storageKey');
    expect(await readdir(join(storageRoot, 'staging'))).toEqual([]);
    expect((await readdir(join(storageRoot, 'objects'))).length).toBe(1);
    expect(fakeDb.getState().history).toHaveLength(1);
    expect(fakeDb.getState().history[0]).toMatchObject({
      recordType: 'DOCUMENT',
      action: 'CREATED',
      operationCorrelation: `file-operation:${first.operationId}:upload`,
    });

    // Replay with exact same key & payload returns same document without creating duplicate file/row
    const replay = await executor.executeStudentUpload(
      actor,
      1,
      'upload-key-1',
      createBufferUploadSource({
        documentType: DocumentType.TRANSCRIPT,
        originalFileName: 'transcript.pdf',
        content: pdf,
      }),
    );
    expect(replay).toEqual(first);
    expect(fakeDb.getState().documents).toHaveLength(1);
    expect((await readdir(join(storageRoot, 'objects'))).length).toBe(1);

    // Same key with different payload fails with 409 IDEMPOTENCY_KEY_CONFLICT
    await expect(
      executor.executeStudentUpload(
        actor,
        1,
        'upload-key-1',
        createBufferUploadSource({
          documentType: DocumentType.OTHER,
          originalFileName: 'transcript.pdf',
          content: pdf,
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT });
  });

  it('cleans up failed uploads completely and records sanitized failure outcome without visible documents', async () => {
    await expect(
      executor.executeStudentUpload(
        actor,
        1,
        'bad-format-key',
        createBufferUploadSource({
          documentType: DocumentType.OTHER,
          originalFileName: 'spoof.pdf',
          content: Buffer.from('not a pdf', 'utf8'),
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.UNSUPPORTED_FILE_FORMAT });

    expect(fakeDb.getState().documents).toHaveLength(0);
    expect(await readdir(join(storageRoot, 'staging'))).toEqual([]);
    expect(await readdir(join(storageRoot, 'objects'))).toEqual([]);
    expect(fakeDb.getState().fileOperations[0]).toMatchObject({
      status: FileOperationStatus.FAILED,
      errorCode: ERROR_CODES.UNSUPPORTED_FILE_FORMAT,
    });

    // Retrying with same key returns recorded failure without rewriting disk
    await expect(
      executor.executeStudentUpload(
        actor,
        1,
        'bad-format-key',
        createBufferUploadSource({
          documentType: DocumentType.OTHER,
          originalFileName: 'spoof.pdf',
          content: Buffer.from('not a pdf', 'utf8'),
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.UNSUPPORTED_FILE_FORMAT });
  });

  it('reconciles expired abandoned uploads into FAILED without auto-publishing and never duplicates in-flight work', async () => {
    const expiredKey = storage.generateKey();
    const expiredObjKey = storage.generateKey();
    const handle = await storage.openExclusiveStagingFile(expiredKey);
    await handle.writeFile(buildMinimalPdf());
    await storage.fsyncAndClose(handle);

    fakeDb.getState().fileOperations.push({
      id: 50,
      kind: FileOperationKind.UPLOAD,
      status: FileOperationStatus.IN_PROGRESS,
      requestedByStaffUserId: actor.staffUserId,
      studentId: 1,
      supervisorId: null,
      documentId: null,
      idempotencyKey: 'abandoned-op',
      requestFingerprint: null,
      stagingKey: expiredKey,
      storageKey: expiredObjKey,
      executorId: 'dead-worker',
      claimToken: 'c'.repeat(64),
      leaseExpiresAt: new Date(now.getTime() - 10_000),
      errorStatus: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    await executor.reconcileNow();

    expect(fakeDb.getState().documents).toHaveLength(0);
    expect(await readdir(join(storageRoot, 'staging'))).toEqual([]);
    expect(await readdir(join(storageRoot, 'objects'))).toEqual([]);
    expect(fakeDb.getState().fileOperations[0]).toMatchObject({
      id: 50,
      status: FileOperationStatus.FAILED,
      errorCode: ERROR_CODES.UPLOAD_INTERRUPTED,
    });
  });

  it('does not unlink promoted artifacts on ambiguous DB errors during publish', async () => {
    const pdf = buildMinimalPdf();
    fakeDb.setOnNextTransactionStart(async () => {
      await Promise.resolve();
      fakeDb.setFailNextPublishWith(new Error('ETIMEDOUT socket closed'));
    });

    await expect(
      executor.executeStudentUpload(
        actor,
        1,
        'ambiguous-commit-key',
        createBufferUploadSource({
          documentType: DocumentType.TRANSCRIPT,
          originalFileName: 'transcript.pdf',
          content: pdf,
        }),
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
    });

    // Status remains IN_PROGRESS and artifact preserved until reconciliation/retry resolves it
    expect(fakeDb.getState().fileOperations[0].status).toBe(
      FileOperationStatus.IN_PROGRESS,
    );
    expect((await readdir(join(storageRoot, 'objects'))).length).toBe(1);
  });

  it('reclaims promoted artifacts immediately on definite PostgreSQL rollback errors (such as 42501) during publish', async () => {
    const pdf = buildMinimalPdf();
    fakeDb.setFailNextPublishWith(adapterError('42501'));

    await expect(
      executor.executeStudentUpload(
        actor,
        1,
        'definite-rollback-42501-key',
        createBufferUploadSource({
          documentType: DocumentType.TRANSCRIPT,
          originalFileName: 'transcript.pdf',
          content: pdf,
        }),
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
    });

    expect(fakeDb.getState().documents).toHaveLength(0);
    expect(fakeDb.getState().fileOperations[0].status).toBe(
      FileOperationStatus.FAILED,
    );
    expect(await readdir(join(storageRoot, 'staging'))).toEqual([]);
    expect(await readdir(join(storageRoot, 'objects'))).toEqual([]);
  });

  it('publishes supervisor uploads exclusively, enforces cross-owner idempotency conflicts, and returns sanitized owner fields', async () => {
    const pdf = buildMinimalPdf();
    const uploaded = await executor.executeSupervisorUpload(
      actor,
      1,
      'sup-upload-key-1',
      createSupervisorBufferUploadSource({
        description: 'External supervision CV',
        originalFileName: 'cv.pdf',
        content: pdf,
      }),
    );

    expect(uploaded.kind).toBe('COMPLETED');
    if (uploaded.kind !== 'COMPLETED') throw new Error('expected completed');
    expect(uploaded.document).toMatchObject({
      studentId: null,
      supervisorId: 1,
      qualificationId: null,
      documentType: DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT,
      description: 'External supervision CV',
    });

    await expect(
      executor.executeStudentUpload(
        actor,
        1,
        'sup-upload-key-1',
        createBufferUploadSource({
          documentType: DocumentType.OTHER,
          originalFileName: 'cv.pdf',
          content: pdf,
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT });

    await expect(
      executor.executeSupervisorUpload(
        actor,
        999,
        'sup-missing-key',
        createSupervisorBufferUploadSource({
          originalFileName: 'cv.pdf',
          content: pdf,
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });
});
