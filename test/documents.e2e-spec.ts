import { PrismaPg } from '@prisma/adapter-pg';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApplication, createApplication } from '../src/bootstrap';
import { ERROR_CODES } from '../src/common/errors/error-codes';
import { loadAppConfig } from '../src/config/app-config';
import { DocumentsService } from '../src/documents/documents.service';
import {
  FILE_OPERATION_FAULT_HOOK,
  type FileOperationFaultCutPoint,
} from '../src/documents/file-operation-executor';
import { createBufferUploadSource } from '../src/documents/multipart-upload';
import {
  DegreeLevel,
  DocumentAvailability,
  DocumentType,
  FileOperationKind,
  FileOperationStatus,
  PrismaClient,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { StaffAccounts } from '../src/staff-access/staff-accounts';
import { StudentsService } from '../src/students/students.service';
import { ChangeHistoryService } from '../src/change-history/change-history.service';
import { StudentArchiveGuardRegistry } from '../src/students/student-archive-guard';
import { provisionAndLogin, type SignedInStaff } from './support/auth-helper';
import {
  buildCorruptJpeg,
  buildCorruptPng,
  buildMacroDocm,
  buildMacroXlsm,
  buildOle2Doc,
  buildPlainZip,
  buildValidDocx,
  buildValidJpeg,
  buildValidPdf,
  buildValidPng,
  buildValidXlsx,
  captureBinaryBody,
} from './support/document-fixtures';
import {
  createTestEnvironment,
  type TestEnvironment,
} from './support/test-environment';

interface StudentPayload {
  id: number;
  selectedPhotoDocumentId: number | null;
  archivedAt: string | null;
  version: number;
}

interface QualificationPayload {
  id: number;
  studentId: number;
  version: number;
}

interface DocumentPayload {
  id: number;
  studentId: number;
  qualificationId: number | null;
  documentType: DocumentType;
  originalFileName: string;
  mimeType: string;
  byteSize: number;
  uploadedAt: string;
  archivedAt: string | null;
  availability: DocumentAvailability;
  deletedAt: string | null;
  deletedByStaffUserId: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface FileOperationPayload {
  id: number;
  kind: FileOperationKind;
  status: FileOperationStatus;
  studentId: number;
  documentId: number | null;
  failureCode: string | null;
  failureMessage: string | null;
}

interface HistoryPayload {
  id: number;
  recordType: string;
  recordId: number | null;
  action: string;
  after: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
}

interface OpenApiDocument {
  paths: Record<
    string,
    Record<string, { responses?: Record<string, unknown> }>
  >;
  components: {
    schemas: Record<string, { properties?: Record<string, unknown> }>;
  };
}

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

describe('student documents, downloads, and selected photo HTTP API (e2e)', () => {
  let app: INestApplication<App>;
  let environment: TestEnvironment;
  let staffOne: SignedInStaff;
  let staffTwo: SignedInStaff;
  let keySeq = 0;

  const nextKey = (prefix = 'doc-e2e') => `${prefix}-${++keySeq}`;

  beforeAll(async () => {
    environment = await createTestEnvironment();
    app = (await createApplication()) as INestApplication<App>;
    staffOne = await provisionAndLogin(app, {
      username: 'docs.e2e.one',
      fullName: 'Docs E2E Staff One',
    });
    staffTwo = await provisionAndLogin(app, {
      username: 'docs.e2e.two',
      fullName: 'Docs E2E Staff Two',
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (environment) {
      await environment.close();
    }
  });

  async function createStudent(
    fullName: string,
    nationalId: string,
    staff = staffOne,
  ): Promise<StudentPayload> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/students')
      .set('Origin', staff.origin)
      .set('Cookie', staff.sessionCookie)
      .set('X-CSRF-Token', staff.csrfToken)
      .send({ fullName, nationalId })
      .expect(201);
    return (res.body as { data: StudentPayload }).data;
  }

  async function createQualification(
    studentId: number,
    degreeLevel: DegreeLevel = DegreeLevel.BACHELOR,
    staff = staffOne,
  ): Promise<QualificationPayload> {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/students/${studentId}/qualifications`)
      .set('Origin', staff.origin)
      .set('Cookie', staff.sessionCookie)
      .set('X-CSRF-Token', staff.csrfToken)
      .send({ degreeLevel })
      .expect(201);
    return (res.body as { data: QualificationPayload }).data;
  }

  async function uploadDocument(
    studentId: number,
    options: {
      documentType: DocumentType;
      qualificationId?: number;
      filename: string;
      contentType?: string;
      data: Buffer;
      idempotencyKey?: string;
      staff?: SignedInStaff;
    },
  ): Promise<{ document: DocumentPayload; operationIdHeader: string }> {
    const staff = options.staff ?? staffOne;
    const req = request(app.getHttpServer())
      .post(`/api/v1/students/${studentId}/documents`)
      .set('Origin', staff.origin)
      .set('Cookie', staff.sessionCookie)
      .set('X-CSRF-Token', staff.csrfToken)
      .set('Idempotency-Key', options.idempotencyKey ?? nextKey())
      .field('documentType', options.documentType);
    if (options.qualificationId !== undefined) {
      req.field('qualificationId', String(options.qualificationId));
    }
    const res = await req
      .attach('file', options.data, {
        filename: options.filename,
        contentType: options.contentType ?? 'application/octet-stream',
      })
      .expect(201);
    return {
      document: (res.body as { data: DocumentPayload }).data,
      operationIdHeader: res.headers['x-file-operation-id'],
    };
  }

  it('requires authentication, CSRF token, and allowed Origin across all document, selected-photo, download, and operation endpoints', async () => {
    const student = await createStudent(
      'Security Gate Student',
      '29801011234561',
    );
    const { document } = await uploadDocument(student.id, {
      documentType: DocumentType.PERSONAL_PHOTO,
      filename: 'photo.png',
      data: buildValidPng(),
    });

    // Unauthenticated (401)
    await request(app.getHttpServer())
      .get(`/api/v1/students/${student.id}/documents`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/documents/${document.id}`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/documents/${document.id}/download`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/documents/${document.id}/history`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/file-operations/by-key')
      .query({ idempotencyKey: 'any' })
      .expect(401);
    await request(app.getHttpServer())
      .put(`/api/v1/students/${student.id}/selected-photo`)
      .send({ expectedVersion: student.version, documentId: document.id })
      .expect(401);

    // Disallowed Origin (403 ORIGIN_NOT_ALLOWED)
    const badOriginRes = await request(app.getHttpServer())
      .patch(`/api/v1/documents/${document.id}`)
      .set('Origin', 'https://evil.example')
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: document.version,
        documentType: DocumentType.OTHER,
      })
      .expect(403);
    expect(badOriginRes.body).toMatchObject({
      code: ERROR_CODES.ORIGIN_NOT_ALLOWED,
    });

    // Missing/wrong CSRF token (403 CSRF_INVALID)
    for (const makeReq of [
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/students/${student.id}/documents`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .set('Idempotency-Key', 'csrf-missing')
          .field('documentType', DocumentType.OTHER)
          .attach('file', buildValidPdf(), { filename: 'doc.pdf' }),
      () =>
        request(app.getHttpServer())
          .put(`/api/v1/students/${student.id}/selected-photo`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .set('X-CSRF-Token', 'wrong-token')
          .send({ expectedVersion: student.version, documentId: document.id }),
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/documents/${document.id}/archive`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .send({ expectedVersion: document.version }),
    ]) {
      const csrfRes = await makeReq().expect(403);
      expect(csrfRes.body).toMatchObject({ code: ERROR_CODES.CSRF_INVALID });
    }
  });

  it('uploads all five approved formats, streams verified downloads with safe headers, and handles unavailable files without leaking paths', async () => {
    const student = await createStudent('Formats Student', '29802021234561');
    const qual = await createQualification(student.id, DegreeLevel.BACHELOR);

    const pdfBytes = buildValidPdf('Arabic Filename Sample');
    const jpegBytes = buildValidJpeg();
    const pngBytes = buildValidPng();
    const docxBytes = buildValidDocx();
    const xlsxBytes = buildValidXlsx();

    const pdfUpload = await uploadDocument(student.id, {
      documentType: DocumentType.BACHELOR_CERTIFICATE,
      qualificationId: qual.id,
      filename: 'شهادة التخرج; "نهائي".pdf',
      contentType: 'application/octet-stream', // ignored; server detects application/pdf
      data: pdfBytes,
    });
    expect(pdfUpload.operationIdHeader).toMatch(/^\d+$/);
    expect(pdfUpload.document).toMatchObject({
      studentId: student.id,
      qualificationId: qual.id,
      documentType: DocumentType.BACHELOR_CERTIFICATE,
      mimeType: 'application/pdf',
      byteSize: pdfBytes.length,
      availability: DocumentAvailability.AVAILABLE,
      archivedAt: null,
      version: 1,
    });
    expect(pdfUpload.document).not.toHaveProperty('storageKey');

    const jpegUpload = await uploadDocument(student.id, {
      documentType: DocumentType.PERSONAL_PHOTO,
      filename: 'photo.jpg',
      data: jpegBytes,
    });
    expect(jpegUpload.document.mimeType).toBe('image/jpeg');

    const pngUpload = await uploadDocument(student.id, {
      documentType: DocumentType.NATIONAL_ID,
      filename: 'national-id.png',
      data: pngBytes,
    });
    expect(pngUpload.document.mimeType).toBe('image/png');

    const docxUpload = await uploadDocument(student.id, {
      documentType: DocumentType.TRANSCRIPT,
      qualificationId: qual.id,
      filename: 'transcript.docx',
      data: docxBytes,
    });
    expect(docxUpload.document.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    const xlsxUpload = await uploadDocument(student.id, {
      documentType: DocumentType.OTHER,
      filename: 'grades.xlsx',
      data: xlsxBytes,
    });
    expect(xlsxUpload.document.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    // Download each format and assert exact bytes + security headers
    const downloadChecks = [
      {
        doc: pdfUpload.document,
        bytes: pdfBytes,
        query: '?disposition=inline',
        expectedDispositionPrefix: 'inline;',
      },
      {
        doc: jpegUpload.document,
        bytes: jpegBytes,
        query: '?disposition=inline',
        expectedDispositionPrefix: 'inline;',
      },
      {
        doc: pngUpload.document,
        bytes: pngBytes,
        query: '',
        expectedDispositionPrefix: 'attachment;',
      },
      {
        doc: docxUpload.document,
        bytes: docxBytes,
        query: '?disposition=inline', // Office MUST force attachment
        expectedDispositionPrefix: 'attachment;',
      },
      {
        doc: xlsxUpload.document,
        bytes: xlsxBytes,
        query: '?disposition=inline', // Office MUST force attachment
        expectedDispositionPrefix: 'attachment;',
      },
    ];

    for (const check of downloadChecks) {
      const dl = await request(app.getHttpServer())
        .get(`/api/v1/documents/${check.doc.id}/download${check.query}`)
        .set('Cookie', staffOne.sessionCookie)
        .buffer(true)
        .parse(captureBinaryBody)
        .expect(200);
      expect(dl.body).toEqual(check.bytes);
      expect(dl.headers['content-type']).toContain(check.doc.mimeType);
      expect(dl.headers['content-length']).toBe(String(check.bytes.length));
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect(dl.headers['cache-control']).toBe('private, no-store');
      expect(dl.headers['content-disposition']).toMatch(
        new RegExp(`^${check.expectedDispositionPrefix}`),
      );
      expect(dl.headers['content-disposition']).toContain('filename="');
      expect(dl.headers['content-disposition']).toContain("filename*=UTF-8''");
    }

    // Downloads must never append history entries
    const dlHistory = await request(app.getHttpServer())
      .get(`/api/v1/documents/${pdfUpload.document.id}/history`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect((dlHistory.body as { total: number }).total).toBe(1);

    // Remove backing file on disk -> 503 FILE_STORAGE_UNAVAILABLE with zero path/key leakage
    const dbRow = await app.get(PrismaService).document.findUniqueOrThrow({
      where: { id: xlsxUpload.document.id },
      select: { storageKey: true },
    });
    await unlink(join(environment.storage.path, 'objects', dbRow.storageKey));

    const missingFileRes = await request(app.getHttpServer())
      .get(`/api/v1/documents/${xlsxUpload.document.id}/download`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(503);
    expect(missingFileRes.body).toMatchObject({
      code: ERROR_CODES.FILE_STORAGE_UNAVAILABLE,
    });
    const rawMissing = JSON.stringify(missingFileRes.body);
    expect(rawMissing).not.toContain(dbRow.storageKey);
    expect(rawMissing).not.toContain(environment.storage.path);
  });

  it('rejects unsupported, spoofed, macro-enabled, corrupt, mismatched photo, and oversized uploads with zero leftover artifacts', async () => {
    const beforeObjects = await readdir(
      join(environment.storage.path, 'objects'),
    );
    const student = await createStudent(
      'Reject Formats Student',
      '29803031234561',
    );

    const badUploads = [
      {
        label: 'spoofed pdf bytes',
        documentType: DocumentType.OTHER,
        filename: 'fake.pdf',
        data: Buffer.from('not really a pdf', 'utf8'),
        expectedStatus: 400,
        expectedCode: ERROR_CODES.UNSUPPORTED_FILE_FORMAT,
      },
      {
        label: 'legacy OLE2 doc',
        documentType: DocumentType.OTHER,
        filename: 'legacy.doc',
        data: buildOle2Doc(),
        expectedStatus: 400,
        expectedCode: ERROR_CODES.UNSUPPORTED_FILE_FORMAT,
      },
      {
        label: 'plain zip archive',
        documentType: DocumentType.OTHER,
        filename: 'archive.zip',
        data: buildPlainZip(),
        expectedStatus: 400,
        expectedCode: ERROR_CODES.UNSUPPORTED_FILE_FORMAT,
      },
      {
        label: 'macro-enabled docm',
        documentType: DocumentType.OTHER,
        filename: 'macro.docm',
        data: buildMacroDocm(),
        expectedStatus: 400,
        expectedCode: ERROR_CODES.UNSUPPORTED_FILE_FORMAT,
      },
      {
        label: 'macro-enabled xlsm',
        documentType: DocumentType.OTHER,
        filename: 'macro.xlsm',
        data: buildMacroXlsm(),
        expectedStatus: 400,
        expectedCode: ERROR_CODES.UNSUPPORTED_FILE_FORMAT,
      },
      {
        label: 'corrupt png checksum',
        documentType: DocumentType.PERSONAL_PHOTO,
        filename: 'corrupt.png',
        data: buildCorruptPng(),
        expectedStatus: 400,
        expectedCode: ERROR_CODES.UNSUPPORTED_FILE_FORMAT,
      },
      {
        label: 'corrupt jpeg frame',
        documentType: DocumentType.PERSONAL_PHOTO,
        filename: 'corrupt.jpg',
        data: buildCorruptJpeg(),
        expectedStatus: 400,
        expectedCode: ERROR_CODES.UNSUPPORTED_FILE_FORMAT,
      },
      {
        label: 'PDF uploaded as PERSONAL_PHOTO',
        documentType: DocumentType.PERSONAL_PHOTO,
        filename: 'photo.pdf',
        data: buildValidPdf('Not an image'),
        expectedStatus: 400,
        expectedCode: ERROR_CODES.INVALID_PERSONAL_PHOTO_FORMAT,
      },
    ];

    for (const bad of badUploads) {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/students/${student.id}/documents`)
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .set('Idempotency-Key', nextKey('reject'))
        .field('documentType', bad.documentType)
        .attach('file', bad.data, { filename: bad.filename })
        .expect(bad.expectedStatus);
      expect(res.body).toMatchObject({ code: bad.expectedCode });
    }

    // Missing Idempotency-Key -> 400 VALIDATION_ERROR
    await request(app.getHttpServer())
      .post(`/api/v1/students/${student.id}/documents`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .field('documentType', DocumentType.OTHER)
      .attach('file', buildValidPdf(), { filename: 'nokey.pdf' })
      .expect(400);

    const listRes = await request(app.getHttpServer())
      .get(`/api/v1/students/${student.id}/documents`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect((listRes.body as { items: unknown[] }).items).toEqual([]);
    expect(await readdir(join(environment.storage.path, 'staging'))).toEqual(
      [],
    );
    expect(await readdir(join(environment.storage.path, 'objects'))).toEqual(
      beforeObjects,
    );

    // Dedicated app with UPLOAD_MAX_BYTES=2048 enforces FILE_TOO_LARGE
    const limitEnv = await createTestEnvironment();
    let limitApp: INestApplication<App> | undefined;
    try {
      limitApp = (await createApplication({
        env: { ...process.env, UPLOAD_MAX_BYTES: '2048' },
      })) as INestApplication<App>;
      const limitStaff = await provisionAndLogin(limitApp, {
        username: 'limit.staff',
      });
      const s = await request(limitApp.getHttpServer())
        .post('/api/v1/students')
        .set('Origin', limitStaff.origin)
        .set('Cookie', limitStaff.sessionCookie)
        .set('X-CSRF-Token', limitStaff.csrfToken)
        .send({ fullName: 'Limit Student', nationalId: '29803031234569' })
        .expect(201);
      const limitStudentId = (s.body as { data: StudentPayload }).data.id;

      const tooBig = Buffer.concat([
        buildValidPdf('Big'),
        Buffer.alloc(2200, 0x20),
      ]);
      const oversizedRes = await request(limitApp.getHttpServer())
        .post(`/api/v1/students/${limitStudentId}/documents`)
        .set('Origin', limitStaff.origin)
        .set('Cookie', limitStaff.sessionCookie)
        .set('X-CSRF-Token', limitStaff.csrfToken)
        .set('Idempotency-Key', 'too-large-key')
        .field('documentType', DocumentType.OTHER)
        .attach('file', tooBig, { filename: 'oversized.pdf' })
        .expect(400);
      expect(oversizedRes.body).toMatchObject({
        code: ERROR_CODES.FILE_TOO_LARGE,
      });
      expect(await readdir(join(limitEnv.storage.path, 'staging'))).toEqual([]);
      expect(await readdir(join(limitEnv.storage.path, 'objects'))).toEqual([]);
    } finally {
      if (limitApp) {
        await limitApp.close();
      }
      await limitEnv.close();
    }
  });

  it('enforces staff-scoped idempotency replay/conflict and returns sanitized file-operation status', async () => {
    const beforeObjects = await readdir(
      join(environment.storage.path, 'objects'),
    );
    const studentA = await createStudent('Idemp Student A', '29804041234561');
    const studentB = await createStudent('Idemp Student B', '29804041234562');
    const pdfBytes = buildValidPdf('Idempotent Payload');
    const sharedKey = 'shared-staff-idemp-key-1';

    const first = await uploadDocument(studentA.id, {
      documentType: DocumentType.TRANSCRIPT,
      filename: 'transcript.pdf',
      data: pdfBytes,
      idempotencyKey: sharedKey,
      staff: staffOne,
    });

    // Replay by same staff with exact same key & payload returns same document without extra file
    const replay = await uploadDocument(studentA.id, {
      documentType: DocumentType.TRANSCRIPT,
      filename: 'transcript.pdf',
      data: pdfBytes,
      idempotencyKey: sharedKey,
      staff: staffOne,
    });
    expect(replay.document.id).toBe(first.document.id);
    expect(replay.operationIdHeader).toBe(first.operationIdHeader);
    expect(
      (await readdir(join(environment.storage.path, 'objects'))).length,
    ).toBe(beforeObjects.length + 1);

    // Same staff + same key + different payload/category/student -> 409 IDEMPOTENCY_KEY_CONFLICT
    const conflictCategory = await request(app.getHttpServer())
      .post(`/api/v1/students/${studentA.id}/documents`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .set('Idempotency-Key', sharedKey)
      .field('documentType', DocumentType.OTHER)
      .attach('file', pdfBytes, { filename: 'transcript.pdf' })
      .expect(409);
    expect(conflictCategory.body).toMatchObject({
      code: ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
    });

    const conflictStudent = await request(app.getHttpServer())
      .post(`/api/v1/students/${studentB.id}/documents`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .set('Idempotency-Key', sharedKey)
      .field('documentType', DocumentType.TRANSCRIPT)
      .attach('file', pdfBytes, { filename: 'transcript.pdf' })
      .expect(409);
    expect(conflictStudent.body).toMatchObject({
      code: ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
    });

    // Different staff user can reuse the same Idempotency-Key independently
    const staffTwoUpload = await uploadDocument(studentB.id, {
      documentType: DocumentType.TRANSCRIPT,
      filename: 'transcript.pdf',
      data: pdfBytes,
      idempotencyKey: sharedKey,
      staff: staffTwo,
    });
    expect(staffTwoUpload.document.id).not.toBe(first.document.id);

    // Look up operation by ID and by key with strictly sanitized DTO
    const byIdRes = await request(app.getHttpServer())
      .get(`/api/v1/file-operations/${first.operationIdHeader}`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    const byKeyRes = await request(app.getHttpServer())
      .get('/api/v1/file-operations/by-key')
      .query({ kind: FileOperationKind.UPLOAD, idempotencyKey: sharedKey })
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    const opData = (byIdRes.body as { data: FileOperationPayload }).data;
    expect(opData).toEqual(
      (byKeyRes.body as { data: FileOperationPayload }).data,
    );
    expect(opData).toMatchObject({
      id: Number(first.operationIdHeader),
      kind: FileOperationKind.UPLOAD,
      status: FileOperationStatus.COMPLETED,
      studentId: studentA.id,
      documentId: first.document.id,
      failureCode: null,
      failureMessage: null,
    });
    for (const secretField of [
      'storageKey',
      'stagingKey',
      'claimToken',
      'executorId',
      'requestFingerprint',
    ]) {
      expect(opData).not.toHaveProperty(secretField);
    }

    // Staff-two lookup by key resolves staff-two's own operation, while unknown key -> 404
    const twoByKey = await request(app.getHttpServer())
      .get('/api/v1/file-operations/by-key')
      .query({ idempotencyKey: sharedKey })
      .set('Cookie', staffTwo.sessionCookie)
      .expect(200);
    expect((twoByKey.body as { data: FileOperationPayload }).data.id).toBe(
      Number(staffTwoUpload.operationIdHeader),
    );
    await request(app.getHttpServer())
      .get('/api/v1/file-operations/by-key')
      .query({ idempotencyKey: 'nonexistent-key' })
      .set('Cookie', staffTwo.sessionCookie)
      .expect(404);
  });

  it('manages selected personal photo selection, replacement, clearing, archive guard, and rejections', async () => {
    const studentA = await createStudent('Photo Owner A', '29805051234561');
    const studentB = await createStudent('Photo Owner B', '29805051234562');

    const { document: photo1 } = await uploadDocument(studentA.id, {
      documentType: DocumentType.PERSONAL_PHOTO,
      filename: 'photo1.png',
      data: buildValidPng(),
    });
    const { document: photo2 } = await uploadDocument(studentA.id, {
      documentType: DocumentType.PERSONAL_PHOTO,
      filename: 'photo2.jpg',
      data: buildValidJpeg(),
    });
    const { document: transcriptDoc } = await uploadDocument(studentA.id, {
      documentType: DocumentType.TRANSCRIPT,
      filename: 'transcript.pdf',
      data: buildValidPdf(),
    });
    const { document: studentBPhoto } = await uploadDocument(studentB.id, {
      documentType: DocumentType.PERSONAL_PHOTO,
      filename: 'other-photo.png',
      data: buildValidPng(),
    });

    // Select photo1
    const selectedRes = await request(app.getHttpServer())
      .put(`/api/v1/students/${studentA.id}/selected-photo`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: studentA.version, documentId: photo1.id })
      .expect(200);
    const afterSelect1 = (selectedRes.body as { data: StudentPayload }).data;
    expect(afterSelect1).toMatchObject({
      selectedPhotoDocumentId: photo1.id,
      version: 2,
    });

    // Archiving selected photo blocked by DocumentArchiveGuardRegistry -> 409 DOCUMENT_SELECTED_AS_PHOTO
    const blockedArchive = await request(app.getHttpServer())
      .post(`/api/v1/documents/${photo1.id}/archive`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: photo1.version })
      .expect(409);
    expect(blockedArchive.body).toMatchObject({
      code: ERROR_CODES.DOCUMENT_SELECTED_AS_PHOTO,
    });

    // Changing selected photo category away from PERSONAL_PHOTO is blocked
    const blockedRetype = await request(app.getHttpServer())
      .patch(`/api/v1/documents/${photo1.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: photo1.version,
        documentType: DocumentType.OTHER,
      })
      .expect(409);
    expect(blockedRetype.body).toMatchObject({
      code: ERROR_CODES.DOCUMENT_SELECTED_AS_PHOTO,
    });

    // Rejections on selected-photo endpoint
    const wrongOwnerRes = await request(app.getHttpServer())
      .put(`/api/v1/students/${studentA.id}/selected-photo`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: afterSelect1.version,
        documentId: studentBPhoto.id,
      })
      .expect(409);
    expect(wrongOwnerRes.body).toMatchObject({
      code: ERROR_CODES.DOCUMENT_OWNER_MISMATCH,
    });

    const nonPhotoRes = await request(app.getHttpServer())
      .put(`/api/v1/students/${studentA.id}/selected-photo`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: afterSelect1.version,
        documentId: transcriptDoc.id,
      })
      .expect(409);
    expect(nonPhotoRes.body).toMatchObject({
      code: ERROR_CODES.INVALID_SELECTED_PHOTO,
    });

    await request(app.getHttpServer())
      .put(`/api/v1/students/${studentA.id}/selected-photo`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: afterSelect1.version, documentId: 999999 })
      .expect(404);

    // Replace with photo2 -> photo1 can now be archived cleanly
    const replaceRes = await request(app.getHttpServer())
      .put(`/api/v1/students/${studentA.id}/selected-photo`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: afterSelect1.version, documentId: photo2.id })
      .expect(200);
    const afterSelect2 = (replaceRes.body as { data: StudentPayload }).data;
    expect(afterSelect2).toMatchObject({
      selectedPhotoDocumentId: photo2.id,
      version: 3,
    });

    const archivedPhoto1Res = await request(app.getHttpServer())
      .post(`/api/v1/documents/${photo1.id}/archive`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: photo1.version })
      .expect(200);
    expect(
      (archivedPhoto1Res.body as { data: DocumentPayload }).data.archivedAt,
    ).not.toBeNull();

    // Selecting archived photo1 fails with DOCUMENT_ARCHIVED
    const archivedSelectRes = await request(app.getHttpServer())
      .put(`/api/v1/students/${studentA.id}/selected-photo`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: afterSelect2.version, documentId: photo1.id })
      .expect(409);
    expect(archivedSelectRes.body).toMatchObject({
      code: ERROR_CODES.DOCUMENT_ARCHIVED,
    });

    // Clear selected photo (documentId: null) and check stale version rejection
    const staleRes = await request(app.getHttpServer())
      .put(`/api/v1/students/${studentA.id}/selected-photo`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: 1, documentId: null })
      .expect(409);
    expect(staleRes.body).toMatchObject({ code: ERROR_CODES.STALE_VERSION });

    const clearedRes = await request(app.getHttpServer())
      .put(`/api/v1/students/${studentA.id}/selected-photo`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: afterSelect2.version, documentId: null })
      .expect(200);
    expect((clearedRes.body as { data: StudentPayload }).data).toMatchObject({
      selectedPhotoDocumentId: null,
      version: 4,
    });
  });

  it('supports metadata updates, archive/restore lifecycle, parent-archive visibility, and newest-first document history', async () => {
    const student = await createStudent(
      'Lifecycle Doc Student',
      '29806061234561',
    );
    const otherStudent = await createStudent(
      'Other Qual Student',
      '29806061234562',
    );
    const qual = await createQualification(student.id, DegreeLevel.BACHELOR);
    const otherQual = await createQualification(
      otherStudent.id,
      DegreeLevel.BACHELOR,
    );
    const archivedQual = await createQualification(
      student.id,
      DegreeLevel.MASTER,
    );
    await request(app.getHttpServer())
      .post(`/api/v1/qualifications/${archivedQual.id}/archive`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: archivedQual.version })
      .expect(200);

    const pdfBytes = buildValidPdf('Lifecycle Doc');
    const { document: doc1 } = await uploadDocument(student.id, {
      documentType: DocumentType.OTHER,
      filename: 'certificate.pdf',
      data: pdfBytes,
    });

    // Reject immutable fields, empty patch, cross-student qual, archived qual, and PDF->PERSONAL_PHOTO
    await request(app.getHttpServer())
      .patch(`/api/v1/documents/${doc1.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: doc1.version, originalFileName: 'forged.pdf' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/api/v1/documents/${doc1.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: doc1.version })
      .expect(400);

    const crossQualRes = await request(app.getHttpServer())
      .patch(`/api/v1/documents/${doc1.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: doc1.version, qualificationId: otherQual.id })
      .expect(409);
    expect(crossQualRes.body).toMatchObject({
      code: ERROR_CODES.DOCUMENT_QUALIFICATION_STUDENT_MISMATCH,
    });

    const archivedQualLinkRes = await request(app.getHttpServer())
      .patch(`/api/v1/documents/${doc1.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: doc1.version,
        qualificationId: archivedQual.id,
      })
      .expect(409);
    expect(archivedQualLinkRes.body).toMatchObject({
      code: ERROR_CODES.QUALIFICATION_ARCHIVED,
    });

    const invalidPhotoTypeRes = await request(app.getHttpServer())
      .patch(`/api/v1/documents/${doc1.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: doc1.version,
        documentType: DocumentType.PERSONAL_PHOTO,
      })
      .expect(409);
    expect(invalidPhotoTypeRes.body).toMatchObject({
      code: ERROR_CODES.INVALID_DOCUMENT_TYPE_FOR_MIME,
    });

    // Valid metadata patch: link qualification and set category
    const patchedRes = await request(app.getHttpServer())
      .patch(`/api/v1/documents/${doc1.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: doc1.version,
        qualificationId: qual.id,
        documentType: DocumentType.BACHELOR_CERTIFICATE,
      })
      .expect(200);
    const v2 = (patchedRes.body as { data: DocumentPayload }).data;
    expect(v2).toMatchObject({
      qualificationId: qual.id,
      documentType: DocumentType.BACHELOR_CERTIFICATE,
      version: 2,
    });

    // Stale version fails
    await request(app.getHttpServer())
      .patch(`/api/v1/documents/${doc1.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: 1, qualificationId: null })
      .expect(409);

    // Archive document -> excluded from default queries, visible with explicit archive flags
    const archivedDocRes = await request(app.getHttpServer())
      .post(`/api/v1/documents/${doc1.id}/archive`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: v2.version })
      .expect(200);
    const v3 = (archivedDocRes.body as { data: DocumentPayload }).data;
    expect(v3.archivedAt).not.toBeNull();
    expect(v3.version).toBe(3);

    await request(app.getHttpServer())
      .get(`/api/v1/documents/${doc1.id}`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/documents/${doc1.id}/download`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/documents/${doc1.id}/history`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(404);

    // Archived list filter & explicit includeArchived download
    const archivedListRes = await request(app.getHttpServer())
      .get(`/api/v1/students/${student.id}/documents`)
      .query({ archiveStatus: 'ARCHIVED' })
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect((archivedListRes.body as { total: number }).total).toBe(1);

    const archivedDl = await request(app.getHttpServer())
      .get(`/api/v1/documents/${doc1.id}/download`)
      .query({ includeArchived: 'true' })
      .set('Cookie', staffOne.sessionCookie)
      .buffer(true)
      .parse(captureBinaryBody)
      .expect(200);
    expect(archivedDl.body).toEqual(pdfBytes);

    // Restore document
    const restoredDocRes = await request(app.getHttpServer())
      .post(`/api/v1/documents/${doc1.id}/restore`)
      .set('Origin', staffTwo.origin)
      .set('Cookie', staffTwo.sessionCookie)
      .set('X-CSRF-Token', staffTwo.csrfToken)
      .send({ expectedVersion: v3.version })
      .expect(200);
    const v4 = (restoredDocRes.body as { data: DocumentPayload }).data;
    expect(v4).toMatchObject({ archivedAt: null, version: 4 });

    // Archive owning qualification -> preserved doc hidden by default, readable/downloadable via includeArchivedQualification/includeArchived, mutations blocked
    const archivedQual2Res = await request(app.getHttpServer())
      .post(`/api/v1/qualifications/${qual.id}/archive`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: qual.version })
      .expect(200);
    const archivedQual2 = (
      archivedQual2Res.body as { data: QualificationPayload }
    ).data;

    const defaultListUnderArchivedQual = await request(app.getHttpServer())
      .get(`/api/v1/students/${student.id}/documents`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect(
      (defaultListUnderArchivedQual.body as { items: unknown[] }).items,
    ).toEqual([]);

    await request(app.getHttpServer())
      .get(`/api/v1/documents/${doc1.id}`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(404);

    const preservedListUnderArchivedQual = await request(app.getHttpServer())
      .get(`/api/v1/students/${student.id}/documents`)
      .query({ includeArchivedQualification: 'true' })
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect(
      (preservedListUnderArchivedQual.body as { total: number }).total,
    ).toBe(1);

    const preservedDlUnderArchivedQual = await request(app.getHttpServer())
      .get(`/api/v1/documents/${doc1.id}/download`)
      .query({ includeArchived: 'true' })
      .set('Cookie', staffOne.sessionCookie)
      .buffer(true)
      .parse(captureBinaryBody)
      .expect(200);
    expect(preservedDlUnderArchivedQual.body).toEqual(pdfBytes);

    const blockedByArchivedQual = await request(app.getHttpServer())
      .post(`/api/v1/documents/${doc1.id}/archive`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: v4.version })
      .expect(409);
    expect(blockedByArchivedQual.body).toMatchObject({
      code: ERROR_CODES.QUALIFICATION_ARCHIVED,
    });

    await request(app.getHttpServer())
      .post(`/api/v1/qualifications/${qual.id}/restore`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: archivedQual2.version })
      .expect(200);

    // Archive owning student -> preserved doc readable with includeArchivedStudent/includeArchived, mutations blocked
    const archivedStudentRes = await request(app.getHttpServer())
      .post(`/api/v1/students/${student.id}/archive`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: student.version })
      .expect(200);
    const archivedStudent = (
      archivedStudentRes.body as { data: StudentPayload }
    ).data;

    await request(app.getHttpServer())
      .get(`/api/v1/students/${student.id}/documents`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(404);

    const underArchivedStudentList = await request(app.getHttpServer())
      .get(`/api/v1/students/${student.id}/documents`)
      .query({ includeArchivedStudent: 'true' })
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect((underArchivedStudentList.body as { total: number }).total).toBe(1);

    const preservedDlUnderArchivedStudent = await request(app.getHttpServer())
      .get(`/api/v1/documents/${doc1.id}/download`)
      .query({ includeArchived: 'true' })
      .set('Cookie', staffOne.sessionCookie)
      .buffer(true)
      .parse(captureBinaryBody)
      .expect(200);
    expect(preservedDlUnderArchivedStudent.body).toEqual(pdfBytes);

    const blockedMutate = await request(app.getHttpServer())
      .post(`/api/v1/documents/${doc1.id}/archive`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: v4.version })
      .expect(409);
    expect(blockedMutate.body).toMatchObject({
      code: ERROR_CODES.STUDENT_ARCHIVED,
    });

    const blockedUpload = await request(app.getHttpServer())
      .post(`/api/v1/students/${student.id}/documents`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .set('Idempotency-Key', nextKey('archived-student'))
      .field('documentType', DocumentType.OTHER)
      .attach('file', pdfBytes, { filename: 'blocked.pdf' })
      .expect(409);
    expect(blockedUpload.body).toMatchObject({
      code: ERROR_CODES.STUDENT_ARCHIVED,
    });

    // Restore student and inspect newest-first history
    await request(app.getHttpServer())
      .post(`/api/v1/students/${student.id}/restore`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: archivedStudent.version })
      .expect(200);

    const historyRes = await request(app.getHttpServer())
      .get(`/api/v1/documents/${doc1.id}/history`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    const historyBody = historyRes.body as {
      items: HistoryPayload[];
      total: number;
    };
    expect(historyBody.total).toBe(4);
    expect(historyBody.items.map((h) => h.action)).toEqual([
      'RESTORED',
      'ARCHIVED',
      'UPDATED',
      'CREATED',
    ]);
    for (const entry of historyBody.items) {
      if (entry.before) {
        expect(entry.before).not.toHaveProperty('storageKey');
      }
      if (entry.after) {
        expect(entry.after).not.toHaveProperty('storageKey');
      }
    }

    // No permanent document deletion route in Slice 8
    await request(app.getHttpServer())
      .delete(`/api/v1/documents/${doc1.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .expect(404);
  });

  it('drains in-flight file operations before closing PostgreSQL and refuses new uploads during shutdown', async () => {
    const shutdownEnv = await createTestEnvironment();
    let shutdownApp: INestApplication<App> | undefined;
    let closed = false;

    const uploadPaused = deferred();
    const uploadReleased = deferred();
    const events: string[] = [];

    try {
      const config = loadAppConfig({
        ...process.env,
        DATABASE_URL: shutdownEnv.database.runtimeUrl,
        PRIVATE_STORAGE_ROOT: shutdownEnv.storage.path,
      });

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(FILE_OPERATION_FAULT_HOOK)
        .useValue({
          async onCutPoint(cutPoint: FileOperationFaultCutPoint) {
            if (cutPoint === 'AFTER_STAGING_WRITE') {
              uploadPaused.resolve();
              await uploadReleased.promise;
            }
          },
        })
        .compile();

      shutdownApp = moduleRef.createNestApplication();
      configureApplication(shutdownApp, config);
      await shutdownApp.init();

      const prisma = shutdownApp.get(PrismaService);
      const disconnect = prisma.$disconnect.bind(prisma) as () => Promise<void>;
      jest.spyOn(prisma, '$disconnect').mockImplementation(async () => {
        events.push('database-disconnected');
        await disconnect();
      });

      const staff = await new StaffAccounts(prisma).provision(
        { attribution: 'shutdown drain test' },
        {
          username: 'shutdown.docs.staff',
          fullName: 'Shutdown Docs Staff',
          password: 'shutdown docs valid password',
        },
      );
      const student = await new StudentsService(
        prisma,
        new ChangeHistoryService(prisma),
        new StudentArchiveGuardRegistry(),
      ).createStudent(
        { staffUserId: staff.id },
        { fullName: 'Shutdown Drain Student', nationalId: '29807071234561' },
      );

      const docsService = shutdownApp.get(DocumentsService);
      const pdfBytes = buildValidPdf('Graceful Shutdown Upload');
      const inFlightUpload = docsService
        .uploadStudentDocument(
          { staffUserId: staff.id },
          student.id,
          'shutdown-drain-key',
          createBufferUploadSource({
            documentType: DocumentType.TRANSCRIPT,
            originalFileName: 'shutdown.pdf',
            content: pdfBytes,
          }),
        )
        .then((res) => {
          events.push('upload-completed');
          return res;
        });

      await uploadPaused.promise;

      let closeResolved = false;
      const closePromise = shutdownApp.close().then(() => {
        closeResolved = true;
      });
      closed = true;

      // Allow onModuleDestroy to begin awaiting drain()
      await delay(25);
      expect(closeResolved).toBe(false);

      // New uploads admitted after shutdown starts must reject immediately with 503 SERVICE_UNAVAILABLE
      await expect(
        docsService.uploadStudentDocument(
          { staffUserId: staff.id },
          student.id,
          'rejected-during-shutdown',
          createBufferUploadSource({
            documentType: DocumentType.OTHER,
            originalFileName: 'late.pdf',
            content: pdfBytes,
          }),
        ),
      ).rejects.toMatchObject({
        status: 503,
        code: ERROR_CODES.SERVICE_UNAVAILABLE,
      });

      uploadReleased.resolve();
      const uploadResult = await inFlightUpload;
      await closePromise;

      expect(uploadResult.kind).toBe('COMPLETED');
      expect(events).toEqual(['upload-completed', 'database-disconnected']);

      const verifyPrisma = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: shutdownEnv.database.runtimeUrl,
        }),
      });
      try {
        expect(
          await verifyPrisma.document.count({
            where: { studentId: student.id },
          }),
        ).toBe(1);
        expect(
          await readdir(join(shutdownEnv.storage.path, 'staging')),
        ).toEqual([]);
      } finally {
        await verifyPrisma.$disconnect();
      }
    } finally {
      uploadReleased.resolve();
      if (shutdownApp && !closed) {
        await shutdownApp.close().catch(() => undefined);
      }
      await shutdownEnv.close();
    }
  });

  it('publishes all document, selected-photo, and file-operation routes and schemas in OpenAPI without DELETE route', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    const doc = res.body as OpenApiDocument;

    for (const [path, methods] of [
      ['/api/v1/students/{studentId}/documents', ['get', 'post']],
      ['/api/v1/documents/{id}', ['get', 'patch']],
      ['/api/v1/documents/{id}/download', ['get']],
      ['/api/v1/documents/{id}/archive', ['post']],
      ['/api/v1/documents/{id}/restore', ['post']],
      ['/api/v1/documents/{id}/history', ['get']],
      ['/api/v1/file-operations/by-key', ['get']],
      ['/api/v1/file-operations/{id}', ['get']],
      ['/api/v1/students/{id}/selected-photo', ['put']],
    ] as const) {
      expect(doc.paths[path]).toBeDefined();
      for (const method of methods) {
        expect(doc.paths[path][method]).toBeDefined();
        for (const status of ['400', '401', '403', '404', '409']) {
          expect(doc.paths[path][method].responses?.[status]).toBeDefined();
        }
      }
    }

    expect(doc.paths['/api/v1/documents/{id}']?.delete).toBeUndefined();

    const docSchema = doc.components.schemas['DocumentDto'];
    expect(docSchema?.properties).toBeDefined();
    expect(docSchema.properties).not.toHaveProperty('storageKey');
    for (const field of [
      'id',
      'studentId',
      'qualificationId',
      'documentType',
      'originalFileName',
      'mimeType',
      'byteSize',
      'uploadedAt',
      'archivedAt',
      'availability',
      'deletedAt',
      'deletedByStaffUserId',
      'version',
      'createdAt',
      'updatedAt',
    ]) {
      expect(docSchema.properties).toHaveProperty(field);
    }

    const opSchema = doc.components.schemas['FileOperationDto'];
    expect(opSchema?.properties).toBeDefined();
    expect(opSchema.properties).not.toHaveProperty('storageKey');
    expect(opSchema.properties).not.toHaveProperty('stagingKey');
    expect(opSchema.properties).not.toHaveProperty('claimToken');
  });
});
