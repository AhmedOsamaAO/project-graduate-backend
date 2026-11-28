import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createApplication } from '../src/bootstrap';
import { ERROR_CODES } from '../src/common/errors/error-codes';
import {
  AcademicRank,
  DocumentAvailability,
  DocumentType,
  ExternalApprovalStatus,
  FileOperationKind,
  FileOperationStatus,
  InstitutionType,
  SupervisorAffiliation,
} from '../src/generated/prisma/client';
import { FIXED_OFFICE } from '../src/reference-data/fixed-office';
import { provisionAndLogin, type SignedInStaff } from './support/auth-helper';
import {
  buildCorruptPng,
  buildMacroDocm,
  buildValidDocx,
  buildValidPdf,
  buildValidPng,
  captureBinaryBody,
} from './support/document-fixtures';
import {
  createTestEnvironment,
  type TestEnvironment,
} from './support/test-environment';

interface SupervisorPayload {
  id: number;
  fullName: string;
  academicRank: AcademicRank;
  affiliation: SupervisorAffiliation;
  departmentId: number | null;
  workplace: string | null;
  phone: string | null;
  email: string | null;
  nationalId: string | null;
  externalApprovalStatus: ExternalApprovalStatus | null;
  externalRejectionReason: string | null;
  deactivatedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface DocumentPayload {
  id: number;
  studentId: number | null;
  supervisorId: number | null;
  qualificationId: number | null;
  documentType: DocumentType;
  description: string | null;
  originalFileName: string;
  mimeType: string;
  byteSize: number;
  archivedAt: string | null;
  availability: DocumentAvailability;
  version: number;
}

interface FileOperationPayload {
  id: number;
  kind: FileOperationKind;
  status: FileOperationStatus;
  studentId: number | null;
  supervisorId: number | null;
  documentId: number | null;
  failureCode: string | null;
}

interface HistoryPayload {
  id: number;
  recordType: string;
  recordId: number | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
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

describe('supervisors, external approval, and supervisor documents HTTP API (e2e)', () => {
  let app: INestApplication<App>;
  let environment: TestEnvironment;
  let staffOne: SignedInStaff;
  let staffTwo: SignedInStaff;
  let operatingDeptId: number;
  let externalDeptId: number;
  let keySeq = 0;

  const nextKey = (prefix = 'sup-e2e') => `${prefix}-${++keySeq}`;

  beforeAll(async () => {
    environment = await createTestEnvironment();
    app = (await createApplication()) as INestApplication<App>;
    staffOne = await provisionAndLogin(app, {
      username: 'sup.e2e.one',
      fullName: 'Supervisors E2E One',
    });
    staffTwo = await provisionAndLogin(app, {
      username: 'sup.e2e.two',
      fullName: 'Supervisors E2E Two',
    });

    const deptRes = await request(app.getHttpServer())
      .post('/api/v1/departments')
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        facultyId: FIXED_OFFICE.faculty.id,
        name: 'Computer Science (E2E)',
      })
      .expect(201);
    operatingDeptId = (deptRes.body as { data: { id: number } }).data.id;

    const instRes = await request(app.getHttpServer())
      .post('/api/v1/institutions')
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        name: 'External Engineering University (E2E)',
        institutionType: InstitutionType.PUBLIC_UNIVERSITY,
      })
      .expect(201);
    const instId = (instRes.body as { data: { id: number } }).data.id;

    const facRes = await request(app.getHttpServer())
      .post('/api/v1/faculties')
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ institutionId: instId, name: 'Engineering Faculty (E2E)' })
      .expect(201);
    const facId = (facRes.body as { data: { id: number } }).data.id;

    const extDeptRes = await request(app.getHttpServer())
      .post('/api/v1/departments')
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ facultyId: facId, name: 'Electrical Engineering (E2E)' })
      .expect(201);
    externalDeptId = (extDeptRes.body as { data: { id: number } }).data.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (environment) {
      await environment.close();
    }
  });

  async function createSupervisor(
    payload: Record<string, unknown>,
    staff = staffOne,
  ): Promise<SupervisorPayload> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/supervisors')
      .set('Origin', staff.origin)
      .set('Cookie', staff.sessionCookie)
      .set('X-CSRF-Token', staff.csrfToken)
      .send(payload)
      .expect(201);
    return (res.body as { data: SupervisorPayload }).data;
  }

  it('requires authentication, CSRF token, and allowed Origin across all supervisor and supervisor-document routes', async () => {
    const sup = await createSupervisor({
      fullName: 'Dr. Auth Target',
      academicRank: AcademicRank.PROFESSOR,
      affiliation: SupervisorAffiliation.EXTERNAL,
      workplace: 'Cairo University',
    });

    await request(app.getHttpServer()).get('/api/v1/supervisors').expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/supervisors/${sup.id}`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/supervisors/${sup.id}/history`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/supervisors/${sup.id}/documents`)
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/supervisors')
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .send({
        fullName: 'Missing CSRF',
        academicRank: AcademicRank.LECTURER,
        affiliation: SupervisorAffiliation.EXTERNAL,
        workplace: 'Uni',
      })
      .expect(403);

    await request(app.getHttpServer())
      .put(`/api/v1/supervisors/${sup.id}/external-approval`)
      .set('Origin', 'https://evil.example')
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: sup.version,
        status: ExternalApprovalStatus.REJECTED,
      })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/supervisors/${sup.id}/deactivate`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .send({ expectedVersion: sup.version })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/supervisors/${sup.id}/documents`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('Idempotency-Key', nextKey('csrf-fail'))
      .attach('file', buildValidPdf('No CSRF'), 'doc.pdf')
      .expect(403);
  });

  it('supports internal and external CRUD, affiliation rules, transitions, stale versions, and typed search/filters', async () => {
    // Reject internal supervisor with workplace or non-operating department
    const badWorkplace = await request(app.getHttpServer())
      .post('/api/v1/supervisors')
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        fullName: 'Bad Internal',
        academicRank: AcademicRank.PROFESSOR,
        affiliation: SupervisorAffiliation.INTERNAL,
        departmentId: operatingDeptId,
        workplace: 'Not Allowed',
      })
      .expect(400);
    expect((badWorkplace.body as { code: string }).code).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );

    const badFacultyDept = await request(app.getHttpServer())
      .post('/api/v1/supervisors')
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        fullName: 'Wrong Faculty Internal',
        academicRank: AcademicRank.PROFESSOR,
        affiliation: SupervisorAffiliation.INTERNAL,
        departmentId: externalDeptId,
      })
      .expect(409);
    expect((badFacultyDept.body as { code: string }).code).toBe(
      ERROR_CODES.SUPERVISOR_DEPARTMENT_NOT_IN_OPERATING_FACULTY,
    );

    const internal = await createSupervisor({
      fullName: '  د. طارق منصور  ',
      academicRank: AcademicRank.ASSOCIATE_LECTURER,
      affiliation: SupervisorAffiliation.INTERNAL,
      departmentId: operatingDeptId,
      phone: '01009998887',
      email: 'tarek@fci.zu.edu.eg',
      nationalId: '001234',
    });
    expect(internal).toMatchObject({
      fullName: 'د. طارق منصور',
      academicRank: AcademicRank.ASSOCIATE_LECTURER,
      affiliation: SupervisorAffiliation.INTERNAL,
      departmentId: operatingDeptId,
      workplace: null,
      nationalId: '001234',
      externalApprovalStatus: null,
      externalRejectionReason: null,
      deactivatedAt: null,
      version: 1,
    });

    const external = await createSupervisor({
      fullName: 'Dr. International Guest',
      academicRank: AcademicRank.PROFESSOR,
      affiliation: SupervisorAffiliation.EXTERNAL,
      workplace: 'Oxford University',
      departmentId: externalDeptId,
      nationalId: 'UK-001234',
    });
    expect(external).toMatchObject({
      affiliation: SupervisorAffiliation.EXTERNAL,
      departmentId: externalDeptId,
      workplace: 'Oxford University',
      externalApprovalStatus: ExternalApprovalStatus.PENDING,
      nationalId: 'UK-001234',
    });

    // Typed search & nationalId filter preserving leading zeros
    const byIdRes = await request(app.getHttpServer())
      .get('/api/v1/supervisors')
      .set('Cookie', staffOne.sessionCookie)
      .query({ nationalId: '001234', affiliation: 'INTERNAL' })
      .expect(200);
    const byIdItems = (byIdRes.body as { items: SupervisorPayload[] }).items;
    expect(byIdItems.map((s) => s.id)).toEqual([internal.id]);

    const bySearchRes = await request(app.getHttpServer())
      .get('/api/v1/supervisors')
      .set('Cookie', staffOne.sessionCookie)
      .query({ search: 'UK-001234' })
      .expect(200);
    expect(
      (bySearchRes.body as { items: SupervisorPayload[] }).items.map(
        (s) => s.id,
      ),
    ).toEqual([external.id]);

    // Update rank and switch INTERNAL -> EXTERNAL, then check stale version
    const switched = await request(app.getHttpServer())
      .patch(`/api/v1/supervisors/${internal.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: internal.version,
        academicRank: AcademicRank.LECTURER,
        affiliation: SupervisorAffiliation.EXTERNAL,
        workplace: 'Nile University',
      })
      .expect(200);
    const switchedData = (switched.body as { data: SupervisorPayload }).data;
    expect(switchedData).toMatchObject({
      academicRank: AcademicRank.LECTURER,
      affiliation: SupervisorAffiliation.EXTERNAL,
      departmentId: null,
      workplace: 'Nile University',
      externalApprovalStatus: ExternalApprovalStatus.PENDING,
      version: 2,
    });

    const staleRes = await request(app.getHttpServer())
      .patch(`/api/v1/supervisors/${internal.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: 1,
        fullName: 'Stale Overwrite',
      })
      .expect(409);
    expect((staleRes.body as { code: string }).code).toBe(
      ERROR_CODES.STALE_VERSION,
    );
  });

  it('manages supervisor documents, external approval evidence, downloads, archive/restore, and deactivation', async () => {
    const ext = await createSupervisor({
      fullName: 'Dr. External Approval E2E',
      academicRank: AcademicRank.ASSOCIATE_PROFESSOR,
      affiliation: SupervisorAffiliation.EXTERNAL,
      workplace: 'Alexandria University',
    });

    // Cannot approve without unarchived supporting document
    const noDocApprove = await request(app.getHttpServer())
      .put(`/api/v1/supervisors/${ext.id}/external-approval`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: ext.version,
        status: ExternalApprovalStatus.APPROVED,
      })
      .expect(409);
    expect((noDocApprove.body as { code: string }).code).toBe(
      ERROR_CODES.SUPERVISOR_APPROVAL_REQUIRES_DOCUMENT,
    );

    // Format validation rejection records FAILED file operation without visible document
    const badFormatKey = nextKey('bad-fmt');
    const badFormatRes = await request(app.getHttpServer())
      .post(`/api/v1/supervisors/${ext.id}/documents`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .set('Idempotency-Key', badFormatKey)
      .field('description', 'Corrupt PNG')
      .attach('file', buildCorruptPng(), 'bad.png')
      .expect(400);
    expect((badFormatRes.body as { code: string }).code).toBe(
      ERROR_CODES.UNSUPPORTED_FILE_FORMAT,
    );

    const macroKey = nextKey('macro');
    await request(app.getHttpServer())
      .post(`/api/v1/supervisors/${ext.id}/documents`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .set('Idempotency-Key', macroKey)
      .attach('file', buildMacroDocm(), 'macro.docm')
      .expect(400);

    const opByKeyRes = await request(app.getHttpServer())
      .get('/api/v1/file-operations/by-key')
      .set('Cookie', staffOne.sessionCookie)
      .query({ kind: FileOperationKind.UPLOAD, idempotencyKey: badFormatKey })
      .expect(200);
    const failedOp = (opByKeyRes.body as { data: FileOperationPayload }).data;
    expect(failedOp).toMatchObject({
      status: FileOperationStatus.FAILED,
      studentId: null,
      supervisorId: ext.id,
      documentId: null,
      failureCode: ERROR_CODES.UNSUPPORTED_FILE_FORMAT,
    });
    expect(failedOp).not.toHaveProperty('storageKey');

    // Upload valid PDF with description + idempotent replay + conflict
    const pdfKey = nextKey('pdf');
    const pdfBuf = buildValidPdf('Supervisor Evidence PDF');
    const uploadRes = await request(app.getHttpServer())
      .post(`/api/v1/supervisors/${ext.id}/documents`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .set('Idempotency-Key', pdfKey)
      .field('description', 'Faculty board approval memo')
      .attach('file', pdfBuf, 'approval-memo.pdf')
      .expect(201);
    const pdfDoc = (uploadRes.body as { data: DocumentPayload }).data;
    expect(pdfDoc).toMatchObject({
      studentId: null,
      supervisorId: ext.id,
      qualificationId: null,
      documentType: DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT,
      description: 'Faculty board approval memo',
      mimeType: 'application/pdf',
    });
    expect(pdfDoc).not.toHaveProperty('storageKey');

    const replayRes = await request(app.getHttpServer())
      .post(`/api/v1/supervisors/${ext.id}/documents`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .set('Idempotency-Key', pdfKey)
      .field('description', 'Faculty board approval memo')
      .attach('file', pdfBuf, 'approval-memo.pdf')
      .expect(201);
    expect((replayRes.body as { data: DocumentPayload }).data.id).toBe(
      pdfDoc.id,
    );

    const conflictRes = await request(app.getHttpServer())
      .post(`/api/v1/supervisors/${ext.id}/documents`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .set('Idempotency-Key', pdfKey)
      .field('description', 'Different description')
      .attach('file', pdfBuf, 'approval-memo.pdf')
      .expect(409);
    expect((conflictRes.body as { code: string }).code).toBe(
      ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
    );

    // Upload DOCX and PNG for the supervisor as well
    const docxRes = await request(app.getHttpServer())
      .post(`/api/v1/supervisors/${ext.id}/documents`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .set('Idempotency-Key', nextKey('docx'))
      .attach('file', buildValidDocx(), 'cv.docx')
      .expect(201);
    const docxDoc = (docxRes.body as { data: DocumentPayload }).data;

    const dlDocx = await request(app.getHttpServer())
      .get(`/api/v1/documents/${docxDoc.id}/download`)
      .set('Cookie', staffTwo.sessionCookie)
      .query({ disposition: 'inline' })
      .buffer(true)
      .parse(captureBinaryBody)
      .expect(200);
    expect(dlDocx.headers['x-content-type-options']).toBe('nosniff');
    expect(dlDocx.headers['content-disposition']).toMatch(/^attachment;/);
    expect((dlDocx.body as Buffer).length).toBe(docxDoc.byteSize);

    // Update supervisor document description (and reject qualificationId)
    await request(app.getHttpServer())
      .patch(`/api/v1/documents/${pdfDoc.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: pdfDoc.version, qualificationId: 1 })
      .expect(400);

    const updatedPdfDocRes = await request(app.getHttpServer())
      .patch(`/api/v1/documents/${pdfDoc.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: pdfDoc.version,
        description: 'Verified board approval memo',
      })
      .expect(200);
    const updatedPdfDoc = (updatedPdfDocRes.body as { data: DocumentPayload })
      .data;
    expect(updatedPdfDoc.description).toBe('Verified board approval memo');

    // Approve external supervisor now that supporting docs exist
    const approvedRes = await request(app.getHttpServer())
      .put(`/api/v1/supervisors/${ext.id}/external-approval`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: ext.version,
        status: ExternalApprovalStatus.APPROVED,
      })
      .expect(200);
    const approvedSup = (approvedRes.body as { data: SupervisorPayload }).data;
    expect(approvedSup.externalApprovalStatus).toBe(
      ExternalApprovalStatus.APPROVED,
    );

    // Archive one of two docs -> allowed; archive last doc -> blocked!
    await request(app.getHttpServer())
      .post(`/api/v1/documents/${docxDoc.id}/archive`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: docxDoc.version })
      .expect(200);

    const lastDocBlocked = await request(app.getHttpServer())
      .post(`/api/v1/documents/${updatedPdfDoc.id}/archive`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: updatedPdfDoc.version })
      .expect(409);
    expect((lastDocBlocked.body as { code: string }).code).toBe(
      ERROR_CODES.SUPERVISOR_APPROVAL_REQUIRES_DOCUMENT,
    );

    // Upload a fresh PNG, then reject approval, then archive and restore
    const pngRes = await request(app.getHttpServer())
      .post(`/api/v1/supervisors/${ext.id}/documents`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .set('Idempotency-Key', nextKey('png'))
      .attach('file', buildValidPng(), 'id-scan.png')
      .expect(201);
    const pngDoc = (pngRes.body as { data: DocumentPayload }).data;

    const archivedPdfRes = await request(app.getHttpServer())
      .post(`/api/v1/documents/${updatedPdfDoc.id}/archive`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: updatedPdfDoc.version })
      .expect(200);
    const archivedPdf = (archivedPdfRes.body as { data: DocumentPayload }).data;

    await request(app.getHttpServer())
      .post(`/api/v1/documents/${archivedPdf.id}/restore`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: archivedPdf.version })
      .expect(200);

    // List supervisor documents (active only vs archived)
    const activeList = await request(app.getHttpServer())
      .get(`/api/v1/supervisors/${ext.id}/documents`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect(
      (activeList.body as { items: DocumentPayload[] }).items.map((d) => d.id),
    ).toEqual(expect.arrayContaining([updatedPdfDoc.id, pngDoc.id]));

    // Deactivate supervisor and verify double deactivation rejection + continued readability
    const deactivatedRes = await request(app.getHttpServer())
      .post(`/api/v1/supervisors/${ext.id}/deactivate`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: approvedSup.version })
      .expect(200);
    const deactivated = (deactivatedRes.body as { data: SupervisorPayload })
      .data;
    expect(deactivated.deactivatedAt).not.toBeNull();

    const doubleDeact = await request(app.getHttpServer())
      .post(`/api/v1/supervisors/${ext.id}/deactivate`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: deactivated.version })
      .expect(409);
    expect((doubleDeact.body as { code: string }).code).toBe(
      ERROR_CODES.SUPERVISOR_ALREADY_DEACTIVATED,
    );

    const activeFilterRes = await request(app.getHttpServer())
      .get('/api/v1/supervisors')
      .set('Cookie', staffOne.sessionCookie)
      .query({ activityStatus: 'ACTIVE', fullName: ext.fullName })
      .expect(200);
    expect(
      (activeFilterRes.body as { items: SupervisorPayload[] }).items,
    ).toEqual([]);

    // Supervisor history newest-first
    const historyRes = await request(app.getHttpServer())
      .get(`/api/v1/supervisors/${ext.id}/history`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect(
      (historyRes.body as { items: HistoryPayload[] }).items.map(
        (h) => h.action,
      ),
    ).toEqual(['DEACTIVATED', 'UPDATED', 'CREATED']);

    // Document history newest-first
    const docHistoryRes = await request(app.getHttpServer())
      .get(`/api/v1/documents/${archivedPdf.id}/history`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect(
      (docHistoryRes.body as { items: HistoryPayload[] }).items.map(
        (h) => h.action,
      ),
    ).toEqual(['RESTORED', 'ARCHIVED', 'UPDATED', 'CREATED']);
  });

  it('publishes all supervisor and supervisor-document routes and schemas in OpenAPI without DELETE route', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    const doc = res.body as OpenApiDocument;

    for (const [path, methods] of [
      ['/api/v1/supervisors', ['get', 'post']],
      ['/api/v1/supervisors/{id}', ['get', 'patch']],
      ['/api/v1/supervisors/{id}/external-approval', ['put']],
      ['/api/v1/supervisors/{id}/deactivate', ['post']],
      ['/api/v1/supervisors/{id}/history', ['get']],
      ['/api/v1/supervisors/{supervisorId}/documents', ['get', 'post']],
    ] as const) {
      expect(doc.paths[path]).toBeDefined();
      for (const method of methods) {
        expect(doc.paths[path][method]).toBeDefined();
        for (const status of [
          '400',
          '401',
          '403',
          '404',
          '409',
          '500',
          '503',
        ]) {
          expect(doc.paths[path][method].responses?.[status]).toBeDefined();
        }
      }
    }

    expect(doc.paths['/api/v1/supervisors/{id}'].delete).toBeUndefined();
    expect(
      doc.paths['/api/v1/supervisors/{id}/external-approval'].put?.responses?.[
        '200'
      ],
    ).toBeDefined();

    expect(doc.components.schemas.SupervisorDto.properties).toHaveProperty(
      'externalApprovalStatus',
    );
    expect(doc.components.schemas.DocumentDto.properties).toHaveProperty(
      'supervisorId',
    );
    expect(doc.components.schemas.DocumentDto.properties).toHaveProperty(
      'description',
    );
    expect(doc.components.schemas.FileOperationDto.properties).toHaveProperty(
      'supervisorId',
    );
  });
});
