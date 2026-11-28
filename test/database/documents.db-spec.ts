import { PrismaPg } from '@prisma/adapter-pg';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ChangeHistoryService } from '../../src/change-history/change-history.service';
import { ApiError } from '../../src/common/errors/api-error';
import { ERROR_CODES } from '../../src/common/errors/error-codes';
import { loadAppConfig, type AppConfig } from '../../src/config/app-config';
import {
  DocumentArchiveGuardRegistry,
  createSelectedPhotoDocumentArchiveGuard,
} from '../../src/documents/document-archive-guard';
import { DocumentsService } from '../../src/documents/documents.service';
import {
  FileOperationExecutor,
  type FileOperationFaultCutPoint,
  type FileOperationFaultHook,
} from '../../src/documents/file-operation-executor';
import { createBufferUploadSource } from '../../src/documents/multipart-upload';
import { PrivateFileStorage } from '../../src/documents/private-file-storage';
import {
  DegreeLevel,
  DocumentType,
  FileOperationStatus,
  PrismaClient,
} from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { StaffAccounts } from '../../src/staff-access/staff-accounts';
import { QualificationMutationGuardRegistry } from '../../src/students/qualification-mutation-guard';
import { QualificationsService } from '../../src/students/qualifications.service';
import { StudentArchiveGuardRegistry } from '../../src/students/student-archive-guard';
import { StudentsService } from '../../src/students/students.service';
import { buildValidPdf, buildValidPng } from '../support/document-fixtures';
import {
  createTestDatabase,
  withAdminClient,
  type TestDatabase,
} from '../support/test-database';
import { createTestStorage, type TestStorage } from '../support/test-storage';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('student documents, selected photo, and file operations (db)', () => {
  let database: TestDatabase;
  let storage: TestStorage;
  let appConfig: AppConfig;
  let prisma: PrismaClient;
  let historyService: ChangeHistoryService;
  let studentsService: StudentsService;
  let qualificationsService: QualificationsService;
  let storageService: PrivateFileStorage;
  let archiveGuards: DocumentArchiveGuardRegistry;
  let executor: FileOperationExecutor;
  let documentsService: DocumentsService;
  let unregisterSelectedPhotoGuard: (() => void) | undefined;
  let faultCutHookImpl: FileOperationFaultHook = {
    onCutPoint: () => undefined,
  };
  let staffUserId: number;
  let staffUserTwoId: number;

  const extraExecutors: FileOperationExecutor[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    storage = await createTestStorage();
    appConfig = loadAppConfig({
      ...process.env,
      DATABASE_URL: database.runtimeUrl,
      PRIVATE_STORAGE_ROOT: storage.path,
    });
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: database.runtimeUrl }),
    });
    historyService = new ChangeHistoryService(
      prisma as unknown as PrismaService,
    );
    studentsService = new StudentsService(
      prisma as unknown as PrismaService,
      historyService,
      new StudentArchiveGuardRegistry(),
    );
    qualificationsService = new QualificationsService(
      prisma as unknown as PrismaService,
      historyService,
      studentsService,
      new QualificationMutationGuardRegistry(),
    );
    storageService = new PrivateFileStorage(appConfig);
    archiveGuards = new DocumentArchiveGuardRegistry();
    unregisterSelectedPhotoGuard = archiveGuards.register(
      createSelectedPhotoDocumentArchiveGuard(),
    );
    const faultHookProxy: FileOperationFaultHook = {
      onCutPoint(cutPoint, context) {
        return faultCutHookImpl.onCutPoint(cutPoint, context);
      },
    };
    executor = new FileOperationExecutor(
      prisma as unknown as PrismaService,
      appConfig,
      storageService,
      studentsService,
      undefined,
      faultHookProxy,
    );
    await executor.onModuleInit();

    documentsService = new DocumentsService(
      prisma as unknown as PrismaService,
      historyService,
      studentsService,
      archiveGuards,
      storageService,
      executor,
    );

    const accounts = new StaffAccounts(prisma);
    const staffOne = await accounts.provision(
      { attribution: 'documents db test' },
      {
        username: 'documents.db.staff1',
        fullName: 'Documents DB Staff One',
        password: 'documents db valid password 1',
      },
    );
    const staffTwo = await accounts.provision(
      { attribution: 'documents db test' },
      {
        username: 'documents.db.staff2',
        fullName: 'Documents DB Staff Two',
        password: 'documents db valid password 2',
      },
    );
    staffUserId = staffOne.id;
    staffUserTwoId = staffTwo.id;
  });

  afterEach(() => {
    faultCutHookImpl = { onCutPoint: () => undefined };
  });

  afterAll(async () => {
    for (const extra of extraExecutors) {
      await extra.onModuleDestroy().catch(() => undefined);
    }
    await executor?.onModuleDestroy().catch(() => undefined);
    unregisterSelectedPhotoGuard?.();
    await prisma?.$disconnect();
    await storage?.remove();
    await database?.drop();
  });

  async function stagingFiles(): Promise<string[]> {
    return readdir(join(storage.path, 'staging'));
  }

  async function objectFiles(): Promise<string[]> {
    return readdir(join(storage.path, 'objects'));
  }

  it('enforces document and file_operation schema constraints, composite FKs, immutable field trigger, and runtime privileges', async () => {
    const studentA = await studentsService.createStudent(
      { staffUserId },
      { fullName: 'Doc Constraint Student A', nationalId: '29501011234561' },
    );
    const studentB = await studentsService.createStudent(
      { staffUserId },
      { fullName: 'Doc Constraint Student B', nationalId: '29501011234562' },
    );
    const qualB = await qualificationsService.createQualification(
      { staffUserId },
      studentB.id,
      { degreeLevel: DegreeLevel.BACHELOR },
    );

    const validKeyA = 'a'.repeat(64);
    const validKeyB = 'b'.repeat(64);
    const validKeyC = 'c'.repeat(64);

    await withAdminClient(database.url, async (admin) => {
      const { rows: docCols } = await admin.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'document'
         ORDER BY ordinal_position`,
      );
      expect(docCols.map((row) => row.column_name)).toEqual([
        'id',
        'student_id',
        'qualification_id',
        'document_type',
        'original_file_name',
        'storage_key',
        'mime_type',
        'byte_size',
        'uploaded_at',
        'archived_at',
        'availability',
        'deleted_at',
        'deleted_by_staff_user_id',
        'version',
        'created_at',
        'updated_at',
      ]);

      const { rows: opCols } = await admin.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'file_operation'
         ORDER BY ordinal_position`,
      );
      expect(opCols.map((row) => row.column_name)).toEqual([
        'id',
        'kind',
        'status',
        'requested_by_staff_user_id',
        'student_id',
        'document_id',
        'idempotency_key',
        'request_fingerprint',
        'staging_key',
        'storage_key',
        'executor_id',
        'claim_token',
        'lease_expires_at',
        'error_status',
        'error_code',
        'error_message',
        'created_at',
        'updated_at',
        'completed_at',
      ]);

      // Reject malformed document rows & cross-student qualification FK
      const badDocumentSqls = [
        `INSERT INTO document (student_id, qualification_id, document_type, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES (${studentA.id}, ${qualB.id}, 'BACHELOR_CERTIFICATE', 'cert.pdf', '${validKeyB}', 'application/pdf', 100, CURRENT_TIMESTAMP)`,
        `INSERT INTO document (student_id, document_type, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES (${studentA.id}, 'OTHER', 'legacy.doc', '${validKeyB}', 'application/msword', 100, CURRENT_TIMESTAMP)`,
        `INSERT INTO document (student_id, document_type, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES (${studentA.id}, 'OTHER', 'archive.zip', '${validKeyB}', 'application/zip', 100, CURRENT_TIMESTAMP)`,
        `INSERT INTO document (student_id, document_type, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES (${studentA.id}, 'PERSONAL_PHOTO', 'photo.pdf', '${validKeyB}', 'application/pdf', 100, CURRENT_TIMESTAMP)`,
        `INSERT INTO document (student_id, document_type, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES (${studentA.id}, 'OTHER', 'empty.pdf', '${validKeyB}', 'application/pdf', 0, CURRENT_TIMESTAMP)`,
        `INSERT INTO document (student_id, document_type, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES (${studentA.id}, 'OTHER', '   ', '${validKeyB}', 'application/pdf', 100, CURRENT_TIMESTAMP)`,
        `INSERT INTO document (student_id, document_type, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES (${studentA.id}, 'OTHER', 'badkey.pdf', 'not-64-hex', 'application/pdf', 100, CURRENT_TIMESTAMP)`,
        `INSERT INTO document (student_id, document_type, original_file_name, storage_key, mime_type, byte_size, availability, deleted_at, updated_at)
         VALUES (${studentA.id}, 'OTHER', 'doc.pdf', '${validKeyB}', 'application/pdf', 100, 'AVAILABLE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        `INSERT INTO document (student_id, document_type, original_file_name, storage_key, mime_type, byte_size, availability, archived_at, updated_at)
         VALUES (${studentA.id}, 'OTHER', 'doc.pdf', '${validKeyB}', 'application/pdf', 100, 'DELETE_PENDING', NULL, CURRENT_TIMESTAMP)`,
        `INSERT INTO document (student_id, document_type, original_file_name, storage_key, mime_type, byte_size, availability, archived_at, deleted_at, deleted_by_staff_user_id, updated_at)
         VALUES (${studentA.id}, 'OTHER', 'doc.pdf', '${validKeyB}', 'application/pdf', 100, 'DELETED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)`,
        `INSERT INTO document (student_id, document_type, original_file_name, storage_key, mime_type, byte_size, version, updated_at)
         VALUES (${studentA.id}, 'OTHER', 'doc.pdf', '${validKeyB}', 'application/pdf', 100, 0, CURRENT_TIMESTAMP)`,
      ];
      for (const sql of badDocumentSqls) {
        await expect(admin.query(sql)).rejects.toThrow();
      }

      // Insert one valid PERSONAL_PHOTO document owned by studentB
      const { rows: insertedDocs } = await admin.query<{ id: number }>(
        `INSERT INTO document (student_id, document_type, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES (${studentB.id}, 'PERSONAL_PHOTO', 'photo.png', '${validKeyA}', 'image/png', 120, CURRENT_TIMESTAMP)
         RETURNING id`,
      );
      const docBId = insertedDocs[0].id;

      // Cross-student selected_photo_document_id composite FK rejects setting studentB's photo on studentA
      await expect(
        admin.query(
          `UPDATE student SET selected_photo_document_id = ${docBId} WHERE id = ${studentA.id}`,
        ),
      ).rejects.toThrow();

      // Trigger blocks UPDATE of every immutable column
      for (const immutableUpdate of [
        `UPDATE document SET student_id = ${studentA.id} WHERE id = ${docBId}`,
        `UPDATE document SET storage_key = '${validKeyC}' WHERE id = ${docBId}`,
        `UPDATE document SET mime_type = 'image/jpeg' WHERE id = ${docBId}`,
        `UPDATE document SET byte_size = 999 WHERE id = ${docBId}`,
        `UPDATE document SET original_file_name = 'changed.png' WHERE id = ${docBId}`,
        `UPDATE document SET uploaded_at = uploaded_at + INTERVAL '1 second' WHERE id = ${docBId}`,
      ]) {
        await expect(admin.query(immutableUpdate)).rejects.toThrow();
      }

      // Reject malformed file_operation rows & test partial unique index behavior
      const badOpSqls = [
        `INSERT INTO file_operation (kind, status, requested_by_staff_user_id, student_id, idempotency_key, staging_key, storage_key, updated_at)
         VALUES ('UPLOAD', 'IN_PROGRESS', ${staffUserId}, ${studentA.id}, '   ', '${validKeyB}', '${validKeyC}', CURRENT_TIMESTAMP)`,
        `INSERT INTO file_operation (kind, status, requested_by_staff_user_id, student_id, idempotency_key, staging_key, storage_key, updated_at)
         VALUES ('UPLOAD', 'IN_PROGRESS', ${staffUserId}, ${studentA.id}, 'k-no-staging', NULL, '${validKeyC}', CURRENT_TIMESTAMP)`,
        `INSERT INTO file_operation (kind, status, requested_by_staff_user_id, student_id, idempotency_key, staging_key, storage_key, request_fingerprint, updated_at)
         VALUES ('UPLOAD', 'IN_PROGRESS', ${staffUserId}, ${studentA.id}, 'k-bad-fp', '${validKeyB}', '${validKeyC}', 'short', CURRENT_TIMESTAMP)`,
        `INSERT INTO file_operation (kind, status, requested_by_staff_user_id, student_id, idempotency_key, staging_key, storage_key, completed_at, updated_at)
         VALUES ('UPLOAD', 'COMPLETED', ${staffUserId}, ${studentA.id}, 'k-no-doc', '${validKeyB}', '${validKeyC}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        `INSERT INTO file_operation (kind, status, requested_by_staff_user_id, student_id, idempotency_key, staging_key, storage_key, completed_at, updated_at)
         VALUES ('UPLOAD', 'FAILED', ${staffUserId}, ${studentA.id}, 'k-no-err', '${validKeyB}', '${validKeyC}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        `INSERT INTO file_operation (kind, status, requested_by_staff_user_id, student_id, idempotency_key, staging_key, storage_key, completed_at, updated_at)
         VALUES ('UPLOAD', 'IN_PROGRESS', ${staffUserId}, ${studentA.id}, 'k-bad-ts', '${validKeyB}', '${validKeyC}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ];
      for (const sql of badOpSqls) {
        await expect(admin.query(sql)).rejects.toThrow();
      }

      // UPLOAD storage_key is unique across UPLOADs, while DELETE can reuse a document's storage_key
      await admin.query(
        `INSERT INTO file_operation (kind, status, requested_by_staff_user_id, student_id, document_id, idempotency_key, staging_key, storage_key, completed_at, updated_at)
         VALUES ('UPLOAD', 'COMPLETED', ${staffUserId}, ${studentB.id}, ${docBId}, 'upload-unique-1', '${'d'.repeat(64)}', '${validKeyA}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      );
      await expect(
        admin.query(
          `INSERT INTO file_operation (kind, status, requested_by_staff_user_id, student_id, document_id, idempotency_key, staging_key, storage_key, completed_at, updated_at)
           VALUES ('UPLOAD', 'COMPLETED', ${staffUserTwoId}, ${studentB.id}, ${docBId}, 'upload-unique-2', '${'e'.repeat(64)}', '${validKeyA}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        ),
      ).rejects.toThrow();
      await admin.query(
        `INSERT INTO file_operation (kind, status, requested_by_staff_user_id, student_id, document_id, idempotency_key, staging_key, storage_key, updated_at)
         VALUES ('DELETE', 'IN_PROGRESS', ${staffUserId}, ${studentB.id}, ${docBId}, 'delete-reuse-key-1', NULL, '${validKeyA}', CURRENT_TIMESTAMP)`,
      );

      // Unique (requested_by_staff_user_id, kind, idempotency_key)
      await expect(
        admin.query(
          `INSERT INTO file_operation (kind, status, requested_by_staff_user_id, student_id, idempotency_key, staging_key, storage_key, updated_at)
           VALUES ('UPLOAD', 'IN_PROGRESS', ${staffUserId}, ${studentA.id}, 'upload-unique-1', '${'f'.repeat(64)}', '${'0'.repeat(64)}', CURRENT_TIMESTAMP)`,
        ),
      ).rejects.toThrow();
    });

    // Runtime role has NO DELETE or TRUNCATE privileges on document or file_operation
    await expect(
      prisma.$executeRawUnsafe('DELETE FROM document'),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE document'),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe('DELETE FROM file_operation'),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE file_operation'),
    ).rejects.toThrow();
  });

  it('rolls back document publish and reclaims artifacts atomically when change_history insert fails', async () => {
    const beforeObjects = await objectFiles();
    const student = await studentsService.createStudent(
      { staffUserId },
      { fullName: 'Atomic Rollback Student', nationalId: '29502021234561' },
    );

    await withAdminClient(database.url, async (admin) => {
      await admin.query(
        'REVOKE INSERT ON change_history FROM graduate_runtime',
      );
      try {
        await expect(
          documentsService.uploadStudentDocument(
            { staffUserId },
            student.id,
            'atomic-history-fail-key',
            createBufferUploadSource({
              documentType: DocumentType.TRANSCRIPT,
              originalFileName: 'transcript.pdf',
              content: buildValidPdf('Rollback Test'),
            }),
          ),
        ).rejects.toMatchObject({
          code: ERROR_CODES.SERVICE_UNAVAILABLE,
        });
      } finally {
        await admin.query('GRANT INSERT ON change_history TO graduate_runtime');
      }
    });

    expect(
      await prisma.document.count({ where: { studentId: student.id } }),
    ).toBe(0);
    const op = await prisma.fileOperation.findUnique({
      where: {
        requestedByStaffUserId_kind_idempotencyKey: {
          requestedByStaffUserId: staffUserId,
          kind: 'UPLOAD',
          idempotencyKey: 'atomic-history-fail-key',
        },
      },
    });
    expect(op?.status).toBe(FileOperationStatus.FAILED);
    expect(await stagingFiles()).toEqual([]);
    expect(await objectFiles()).toEqual(beforeObjects);
  });

  it('prevents selecting an archived photo or archiving a selected photo across concurrent trials', async () => {
    const student = await studentsService.createStudent(
      { staffUserId },
      { fullName: 'Photo Race Student', nationalId: '29503031234561' },
    );

    for (let trial = 0; trial < 10; trial += 1) {
      const upload = await documentsService.uploadStudentDocument(
        { staffUserId },
        student.id,
        `photo-race-${trial}`,
        createBufferUploadSource({
          documentType: DocumentType.PERSONAL_PHOTO,
          originalFileName: `photo-${trial}.png`,
          content: buildValidPng(),
        }),
      );
      if (upload.kind !== 'COMPLETED') {
        throw new Error('Expected photo upload to complete');
      }

      const freshStudent = await studentsService.getStudent(student.id);
      const doc = upload.document;

      const results = await Promise.allSettled([
        studentsService.setSelectedPhoto({ staffUserId }, freshStudent.id, {
          expectedVersion: freshStudent.version,
          documentId: doc.id,
        }),
        documentsService.archiveDocument({ staffUserId }, doc.id, doc.version),
      ]);

      const fulfilledCount = results.filter(
        (r) => r.status === 'fulfilled',
      ).length;
      expect(fulfilledCount).toBeLessThanOrEqual(1);

      for (const r of results) {
        if (r.status === 'rejected') {
          expect(r.reason).toBeInstanceOf(ApiError);
          expect([
            ERROR_CODES.DOCUMENT_SELECTED_AS_PHOTO,
            ERROR_CODES.DOCUMENT_ARCHIVED,
            ERROR_CODES.RETRYABLE_CONFLICT,
            ERROR_CODES.STALE_VERSION,
          ]).toContain((r.reason as ApiError).code);
        }
      }

      const dbStudent = await prisma.student.findUniqueOrThrow({
        where: { id: student.id },
      });
      const dbDoc = await prisma.document.findUniqueOrThrow({
        where: { id: doc.id },
      });
      const bothSelectedAndArchived =
        dbStudent.selectedPhotoDocumentId === dbDoc.id &&
        dbDoc.archivedAt !== null;
      expect(bothSelectedAndArchived).toBe(false);

      // Clear selection before next trial if this trial selected the photo
      if (dbStudent.selectedPhotoDocumentId !== null) {
        await studentsService.setSelectedPhoto({ staffUserId }, student.id, {
          expectedVersion: dbStudent.version,
          documentId: null,
        });
      }
    }
  });

  it('handles concurrent duplicate uploads with the same staff-scoped idempotency key without duplicates', async () => {
    const beforeObjects = await objectFiles();
    const student = await studentsService.createStudent(
      { staffUserId },
      { fullName: 'Dup Key Race Student', nationalId: '29504041234561' },
    );
    const pdf = buildValidPdf('Duplicate Race');

    const [r1, r2] = await Promise.allSettled([
      documentsService.uploadStudentDocument(
        { staffUserId },
        student.id,
        'concurrent-dup-key',
        createBufferUploadSource({
          documentType: DocumentType.TRANSCRIPT,
          originalFileName: 'transcript.pdf',
          content: pdf,
        }),
      ),
      documentsService.uploadStudentDocument(
        { staffUserId },
        student.id,
        'concurrent-dup-key',
        createBufferUploadSource({
          documentType: DocumentType.TRANSCRIPT,
          originalFileName: 'transcript.pdf',
          content: pdf,
        }),
      ),
    ]);

    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('fulfilled');
    if (r1.status !== 'fulfilled' || r2.status !== 'fulfilled') {
      throw new Error('Expected both concurrent idempotent calls to fulfill');
    }

    const docs = await prisma.document.findMany({
      where: { studentId: student.id },
    });
    expect(docs).toHaveLength(1);
    const docId = docs[0].id;

    const outcomes = [r1.value, r2.value];
    expect(outcomes.some((o) => o.kind === 'COMPLETED')).toBe(true);
    for (const outcome of outcomes) {
      if (outcome.kind === 'COMPLETED') {
        expect(outcome.document.id).toBe(docId);
      } else {
        expect(outcome.operation.studentId).toBe(student.id);
      }
    }

    const historyRows = await prisma.changeHistory.findMany({
      where: { recordType: 'DOCUMENT', recordId: docId },
    });
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0].action).toBe('CREATED');
    expect(historyRows[0].operationCorrelation).toMatch(
      /^file-operation:\d+:upload$/,
    );

    expect(await stagingFiles()).toEqual([]);
    const afterObjects = await objectFiles();
    expect(afterObjects.length).toBe(beforeObjects.length + 1);
  });

  it('rejects publication and cleans up when owning student or attached qualification is archived mid-upload', async () => {
    const beforeObjects = await objectFiles();

    // Case 1: student archived while upload paused right before publish
    const student1 = await studentsService.createStudent(
      { staffUserId },
      { fullName: 'Archive Race Student 1', nationalId: '29505051234561' },
    );
    const paused1 = deferred();
    const release1 = deferred();
    faultCutHookImpl = {
      async onCutPoint(cutPoint: FileOperationFaultCutPoint) {
        if (cutPoint === 'AFTER_PREPARE_BEFORE_PUBLISH') {
          paused1.resolve();
          await release1.promise;
        }
      },
    };

    const upload1 = documentsService.uploadStudentDocument(
      { staffUserId },
      student1.id,
      'archive-student-mid-upload',
      createBufferUploadSource({
        documentType: DocumentType.NATIONAL_ID,
        originalFileName: 'id.pdf',
        content: buildValidPdf('Student Archive Race'),
      }),
    );

    await paused1.promise;
    await studentsService.archiveStudent(
      { staffUserId },
      student1.id,
      student1.version,
    );
    release1.resolve();

    await expect(upload1).rejects.toMatchObject({
      code: ERROR_CODES.STUDENT_ARCHIVED,
    });
    expect(
      await prisma.document.count({ where: { studentId: student1.id } }),
    ).toBe(0);
    expect(await stagingFiles()).toEqual([]);
    expect(await objectFiles()).toEqual(beforeObjects);

    // Case 2: attached qualification archived while upload paused right before publish
    const student2 = await studentsService.createStudent(
      { staffUserId },
      { fullName: 'Archive Race Student 2', nationalId: '29505051234562' },
    );
    const qual2 = await qualificationsService.createQualification(
      { staffUserId },
      student2.id,
      { degreeLevel: DegreeLevel.BACHELOR },
    );
    const paused2 = deferred();
    const release2 = deferred();
    faultCutHookImpl = {
      async onCutPoint(cutPoint: FileOperationFaultCutPoint) {
        if (cutPoint === 'AFTER_PREPARE_BEFORE_PUBLISH') {
          paused2.resolve();
          await release2.promise;
        }
      },
    };

    const upload2 = documentsService.uploadStudentDocument(
      { staffUserId },
      student2.id,
      'archive-qual-mid-upload',
      createBufferUploadSource({
        documentType: DocumentType.BACHELOR_CERTIFICATE,
        qualificationId: qual2.id,
        originalFileName: 'cert.pdf',
        content: buildValidPdf('Qualification Archive Race'),
      }),
    );

    await paused2.promise;
    await qualificationsService.archiveQualification(
      { staffUserId },
      qual2.id,
      qual2.version,
    );
    release2.resolve();

    await expect(upload2).rejects.toMatchObject({
      code: ERROR_CODES.QUALIFICATION_ARCHIVED,
    });
    expect(
      await prisma.document.count({ where: { studentId: student2.id } }),
    ).toBe(0);
    expect(await stagingFiles()).toEqual([]);
    expect(await objectFiles()).toEqual(beforeObjects);
  });

  it('aborts publication cleanly without orphaned files when a competing recovery cleanup claims the operation first', async () => {
    const beforeObjects = await objectFiles();
    const student = await studentsService.createStudent(
      { staffUserId },
      { fullName: 'Cleanup Claim Race Student', nationalId: '29506061234561' },
    );

    const publisherPaused = deferred();
    const publisherRelease = deferred();
    faultCutHookImpl = {
      async onCutPoint(cutPoint: FileOperationFaultCutPoint) {
        if (cutPoint === 'AFTER_PREPARE_BEFORE_PUBLISH') {
          publisherPaused.resolve();
          await publisherRelease.promise;
        }
      },
    };

    const cleanerPaused = deferred();
    const cleanerRelease = deferred();
    const competingExecutor = new FileOperationExecutor(
      prisma as unknown as PrismaService,
      appConfig,
      storageService,
      studentsService,
      undefined,
      {
        async onCutPoint(cutPoint: FileOperationFaultCutPoint) {
          if (cutPoint === 'AFTER_CLEANUP_CLAIM_BEFORE_UNLINK') {
            cleanerPaused.resolve();
            await cleanerRelease.promise;
          }
        },
      },
    );
    extraExecutors.push(competingExecutor);

    const uploadPromise = documentsService.uploadStudentDocument(
      { staffUserId },
      student.id,
      'competing-cleanup-claim-key',
      createBufferUploadSource({
        documentType: DocumentType.TRANSCRIPT,
        originalFileName: 'transcript.pdf',
        content: buildValidPdf('Cleanup Claim Race'),
      }),
    );

    await publisherPaused.promise;
    const reconcilePromise = competingExecutor.reconcileNow({
      includeForeignActive: true,
    });

    await cleanerPaused.promise;
    // Competing cleaner now holds CLEANUP_PENDING; release original publisher first
    publisherRelease.resolve();
    await expect(uploadPromise).rejects.toMatchObject({
      code: ERROR_CODES.UPLOAD_INTERRUPTED,
    });

    expect(
      await prisma.document.count({ where: { studentId: student.id } }),
    ).toBe(0);

    // Now let competing cleaner finish unlinking objects/<key> and marking FAILED
    cleanerRelease.resolve();
    await reconcilePromise;

    const op = await prisma.fileOperation.findUnique({
      where: {
        requestedByStaffUserId_kind_idempotencyKey: {
          requestedByStaffUserId: staffUserId,
          kind: 'UPLOAD',
          idempotencyKey: 'competing-cleanup-claim-key',
        },
      },
    });
    expect(op).toMatchObject({
      status: FileOperationStatus.FAILED,
      errorCode: ERROR_CODES.UPLOAD_INTERRUPTED,
      documentId: null,
    });
    expect(await stagingFiles()).toEqual([]);
    expect(await objectFiles()).toEqual(beforeObjects);
  });
});
