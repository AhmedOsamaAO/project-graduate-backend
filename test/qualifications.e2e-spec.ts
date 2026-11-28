import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createApplication } from '../src/bootstrap';
import {
  formatCalendarDate,
  getOfficeCurrentYear,
  getOfficeToday,
  parseCalendarDate,
} from '../src/common/dates/office-calendar';
import { ERROR_CODES } from '../src/common/errors/error-codes';
import {
  DegreeLevel,
  EquivalencyStatus,
  InstitutionType,
} from '../src/generated/prisma/client';
import { provisionAndLogin, type SignedInStaff } from './support/auth-helper';
import {
  createTestEnvironment,
  type TestEnvironment,
} from './support/test-environment';

interface OpenApiOperation {
  responses?: Record<string, unknown>;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    schemas: Record<string, { properties?: Record<string, unknown> }>;
  };
}

interface StudentPayload {
  id: number;
  version: number;
  archivedAt: string | null;
}

interface CatalogPayload {
  id: number;
  version: number;
}

interface QualificationPayload {
  id: number;
  studentId: number;
  degreeLevel: DegreeLevel;
  qualificationName: string | null;
  institutionId: number | null;
  facultyId: number | null;
  departmentId: number | null;
  graduationYear: number | null;
  overallGrade: string | null;
  equivalencyStatus: EquivalencyStatus;
  equivalencyDecisionNumber: string | null;
  equivalencyDecisionDate: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface HistoryPayload {
  id: number;
  recordType: string;
  recordId: number | null;
  action: string;
  actorKind: string;
  staffUser: { id: number; username: string; fullName: string } | null;
  operatorAttribution: string | null;
  occurredAt: string;
  before: unknown;
  after: unknown;
}

function nextOfficeDate(): string {
  const todayUtc = parseCalendarDate(getOfficeToday())!;
  todayUtc.setUTCDate(todayUtc.getUTCDate() + 1);
  return formatCalendarDate(todayUtc);
}

describe('qualifications HTTP API (e2e)', () => {
  let app: INestApplication<App>;
  let environment: TestEnvironment;
  let staffOne: SignedInStaff;
  let staffTwo: SignedInStaff;

  beforeAll(async () => {
    environment = await createTestEnvironment();
    app = (await createApplication()) as INestApplication<App>;
    staffOne = await provisionAndLogin(app, {
      username: 'qual.staff.one',
      fullName: 'Qualifications Staff One',
    });
    staffTwo = await provisionAndLogin(app, {
      username: 'qual.staff.two',
      fullName: 'Qualifications Staff Two',
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

  async function postJson<T>(
    path: string,
    payload: Record<string, unknown>,
    expectedStatus: number,
    staff = staffOne,
  ): Promise<T> {
    const response = await request(app.getHttpServer())
      .post(path)
      .set('Origin', staff.origin)
      .set('Cookie', staff.sessionCookie)
      .set('X-CSRF-Token', staff.csrfToken)
      .send(payload)
      .expect(expectedStatus);
    return (response.body as { data: T }).data;
  }

  async function patchJson<T>(
    path: string,
    payload: Record<string, unknown>,
    staff = staffOne,
  ): Promise<T> {
    const response = await request(app.getHttpServer())
      .patch(path)
      .set('Origin', staff.origin)
      .set('Cookie', staff.sessionCookie)
      .set('X-CSRF-Token', staff.csrfToken)
      .send(payload)
      .expect(200);
    return (response.body as { data: T }).data;
  }

  function createStudent(fullName: string, nationalId: string) {
    return postJson<StudentPayload>(
      '/api/v1/students',
      { fullName, nationalId },
      201,
    );
  }

  function createQualification(
    studentId: number,
    payload: Record<string, unknown>,
    staff = staffOne,
  ) {
    return postJson<QualificationPayload>(
      `/api/v1/students/${studentId}/qualifications`,
      payload,
      201,
      staff,
    );
  }

  it('rejects unauthenticated requests on all qualification routes and leaks nothing for archived records', async () => {
    const student = await createStudent(
      'Unauth Qual Student',
      '00910101010101',
    );
    const qual = await createQualification(student.id, {
      degreeLevel: DegreeLevel.BACHELOR,
    });
    const archived = await postJson<QualificationPayload>(
      `/api/v1/qualifications/${qual.id}/archive`,
      { expectedVersion: qual.version },
      200,
    );

    for (const makeRequest of [
      () =>
        request(app.getHttpServer()).get(
          `/api/v1/students/${student.id}/qualifications`,
        ),
      () =>
        request(app.getHttpServer()).get(
          `/api/v1/students/${student.id}/qualifications?archiveStatus=ALL&includeArchivedStudent=true`,
        ),
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/students/${student.id}/qualifications`)
          .set('Origin', staffOne.origin)
          .send({ degreeLevel: DegreeLevel.MASTER }),
      () =>
        request(app.getHttpServer()).get(
          `/api/v1/qualifications/${archived.id}`,
        ),
      () =>
        request(app.getHttpServer()).get(
          `/api/v1/qualifications/${archived.id}?includeArchived=true`,
        ),
      () =>
        request(app.getHttpServer())
          .patch(`/api/v1/qualifications/${archived.id}`)
          .set('Origin', staffOne.origin)
          .send({ expectedVersion: archived.version, overallGrade: 'Good' }),
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/qualifications/${archived.id}/archive`)
          .set('Origin', staffOne.origin)
          .send({ expectedVersion: archived.version }),
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/qualifications/${archived.id}/restore`)
          .set('Origin', staffOne.origin)
          .send({ expectedVersion: archived.version }),
      () =>
        request(app.getHttpServer()).get(
          `/api/v1/qualifications/${archived.id}/history`,
        ),
      () =>
        request(app.getHttpServer()).get(
          `/api/v1/qualifications/${archived.id}/history?includeArchived=true`,
        ),
    ]) {
      const response = await makeRequest().expect(401);
      expect(response.body).toEqual({
        code: ERROR_CODES.UNAUTHENTICATED,
        message: 'Authentication required',
      });
    }
  });

  it('enforces Origin and CSRF protection on all state-changing qualification endpoints', async () => {
    const student = await createStudent('CSRF Qual Student', '00920202020202');
    const qual = await createQualification(student.id, {
      degreeLevel: DegreeLevel.BACHELOR,
    });

    for (const makeRequest of [
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/students/${student.id}/qualifications`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .send({ degreeLevel: DegreeLevel.MASTER }),
      () =>
        request(app.getHttpServer())
          .patch(`/api/v1/qualifications/${qual.id}`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .send({ expectedVersion: qual.version, overallGrade: 'Good' }),
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/qualifications/${qual.id}/archive`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .send({ expectedVersion: qual.version }),
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/qualifications/${qual.id}/restore`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .send({ expectedVersion: qual.version }),
    ]) {
      const res = await makeRequest().expect(403);
      expect(res.body).toMatchObject({ code: ERROR_CODES.CSRF_INVALID });
    }

    const badOrigin = await request(app.getHttpServer())
      .post(`/api/v1/students/${student.id}/qualifications`)
      .set('Origin', 'http://untrusted.example')
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ degreeLevel: DegreeLevel.MASTER })
      .expect(403);
    expect(badOrigin.body).toMatchObject({
      code: ERROR_CODES.ORIGIN_NOT_ALLOWED,
    });
  });

  it('creates minimal and full qualifications, resolves/clears awarding hierarchy, rejects conflicts, and displays student degree history', async () => {
    const instA = await postJson<CatalogPayload>(
      '/api/v1/institutions',
      {
        name: 'E2E Qual University A',
        institutionType: InstitutionType.PUBLIC_UNIVERSITY,
      },
      201,
    );
    const instB = await postJson<CatalogPayload>(
      '/api/v1/institutions',
      {
        name: 'E2E Qual University B',
        institutionType: InstitutionType.FOREIGN_INSTITUTION,
      },
      201,
    );
    const facA = await postJson<CatalogPayload>(
      '/api/v1/faculties',
      { institutionId: instA.id, name: 'E2E Faculty A' },
      201,
    );
    const facB = await postJson<CatalogPayload>(
      '/api/v1/faculties',
      { institutionId: instB.id, name: 'E2E Faculty B' },
      201,
    );
    const deptA = await postJson<CatalogPayload>(
      '/api/v1/departments',
      { facultyId: facA.id, name: 'E2E Dept A' },
      201,
    );
    const deptB = await postJson<CatalogPayload>(
      '/api/v1/departments',
      { facultyId: facB.id, name: 'E2E Dept B' },
      201,
    );

    const student = await createStudent(
      'Degree History Student',
      '00930303030303',
    );

    // Minimal qualification (only degreeLevel) defaults to NOT_ASSESSED
    const qMinimal = await createQualification(student.id, {
      degreeLevel: DegreeLevel.BACHELOR,
    });
    expect(qMinimal).toMatchObject({
      studentId: student.id,
      degreeLevel: 'BACHELOR',
      qualificationName: null,
      institutionId: null,
      facultyId: null,
      departmentId: null,
      graduationYear: null,
      overallGrade: null,
      equivalencyStatus: 'NOT_ASSESSED',
      equivalencyDecisionNumber: null,
      equivalencyDecisionDate: null,
      archivedAt: null,
      version: 1,
    });

    // Second BACHELOR allowed, institution-only without placeholder faculty/department
    const qInstOnly = await createQualification(student.id, {
      degreeLevel: DegreeLevel.BACHELOR,
      qualificationName: '  B.Sc. Applied Math  ',
      institutionId: instB.id,
      graduationYear: 2021,
      overallGrade: '  3.75 / 4.00  ',
      equivalencyStatus: EquivalencyStatus.REQUIRED,
    });
    expect(qInstOnly).toMatchObject({
      degreeLevel: 'BACHELOR',
      qualificationName: 'B.Sc. Applied Math',
      institutionId: instB.id,
      facultyId: null,
      departmentId: null,
      graduationYear: 2021,
      overallGrade: '3.75 / 4.00',
      equivalencyStatus: 'REQUIRED',
    });

    // Faculty-only resolves parent institutionId
    const qFacultyOnly = await createQualification(student.id, {
      degreeLevel: DegreeLevel.PROFESSIONAL,
      facultyId: facB.id,
      graduationYear: 2023,
    });
    expect(qFacultyOnly).toMatchObject({
      institutionId: instB.id,
      facultyId: facB.id,
      departmentId: null,
    });

    // Department-only resolves facultyId and institutionId
    const qDeptOnly = await createQualification(student.id, {
      degreeLevel: DegreeLevel.MASTER,
      departmentId: deptA.id,
      graduationYear: 2024,
      equivalencyStatus: EquivalencyStatus.NOT_REQUIRED,
    });
    expect(qDeptOnly).toMatchObject({
      institutionId: instA.id,
      facultyId: facA.id,
      departmentId: deptA.id,
    });

    // Conflicting references rejected with 409 QUALIFICATION_HIERARCHY_CONFLICT
    for (const conflictPayload of [
      {
        degreeLevel: DegreeLevel.PHD,
        institutionId: instB.id,
        facultyId: facA.id,
      },
      {
        degreeLevel: DegreeLevel.PHD,
        facultyId: facB.id,
        departmentId: deptA.id,
      },
      {
        degreeLevel: DegreeLevel.PHD,
        institutionId: null,
        facultyId: facA.id,
      },
    ]) {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/students/${student.id}/qualifications`)
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send(conflictPayload)
        .expect(409);
      expect(res.body).toMatchObject({
        code: ERROR_CODES.QUALIFICATION_HIERARCHY_CONFLICT,
      });
    }

    // PATCH hierarchy conflicts, cross-branch ancestor resolution, & clearing
    for (const badPatch of [
      { expectedVersion: qDeptOnly.version, institutionId: instB.id },
      {
        expectedVersion: qDeptOnly.version,
        institutionId: instA.id,
        facultyId: facB.id,
      },
    ]) {
      const conflictRes = await request(app.getHttpServer())
        .patch(`/api/v1/qualifications/${qDeptOnly.id}`)
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send(badPatch)
        .expect(409);
      expect(conflictRes.body).toMatchObject({
        code: ERROR_CODES.QUALIFICATION_HIERARCHY_CONFLICT,
      });
    }

    const patchSwitchedBranch = await patchJson<QualificationPayload>(
      `/api/v1/qualifications/${qDeptOnly.id}`,
      {
        expectedVersion: qDeptOnly.version,
        departmentId: deptB.id,
      },
    );
    expect(patchSwitchedBranch).toMatchObject({
      institutionId: instB.id,
      facultyId: facB.id,
      departmentId: deptB.id,
      version: 2,
    });

    const patchDeptCleared = await patchJson<QualificationPayload>(
      `/api/v1/qualifications/${qDeptOnly.id}`,
      {
        expectedVersion: patchSwitchedBranch.version,
        facultyId: facA.id,
        departmentId: null,
      },
    );
    expect(patchDeptCleared).toMatchObject({
      institutionId: instA.id,
      facultyId: facA.id,
      departmentId: null,
      version: 3,
    });

    const patchDeptRestored = await patchJson<QualificationPayload>(
      `/api/v1/qualifications/${qDeptOnly.id}`,
      {
        expectedVersion: patchDeptCleared.version,
        departmentId: deptA.id,
      },
    );
    expect(patchDeptRestored).toMatchObject({
      institutionId: instA.id,
      facultyId: facA.id,
      departmentId: deptA.id,
      version: 4,
    });

    // Missing catalog reference -> 404
    const missingCatalog = await request(app.getHttpServer())
      .post(`/api/v1/students/${student.id}/qualifications`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ degreeLevel: DegreeLevel.PHD, departmentId: 999999 })
      .expect(404);
    expect(missingCatalog.body).toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    // Student degree history: filtered, sorted (graduationYear desc with nulls last), and paged
    const sortedHistory = await request(app.getHttpServer())
      .get(
        `/api/v1/students/${student.id}/qualifications?sortBy=graduationYear&sortOrder=desc`,
      )
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect(
      (sortedHistory.body as { items: QualificationPayload[] }).items.map(
        (item) => item.id,
      ),
    ).toEqual([qDeptOnly.id, qFacultyOnly.id, qInstOnly.id, qMinimal.id]);

    const filteredBachelors = await request(app.getHttpServer())
      .get(
        `/api/v1/students/${student.id}/qualifications?degreeLevel=BACHELOR&equivalencyStatus=REQUIRED&page=1&pageSize=1`,
      )
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect(filteredBachelors.body).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 1,
      items: [{ id: qInstOnly.id }],
    });
  });

  it('validates graduation year, Cairo dates, equivalency rules, immutability of studentId, and required fields', async () => {
    const student = await createStudent(
      'Validation Qual Student',
      '00940404040404',
    );
    const otherStudent = await createStudent(
      'Other Qual Student',
      '00940404040405',
    );
    const qual = await createQualification(student.id, {
      degreeLevel: DegreeLevel.BACHELOR,
    });

    const nextYear = getOfficeCurrentYear() + 1;
    const tomorrow = nextOfficeDate();

    for (const badCreate of [
      {},
      { degreeLevel: 'DIPLOMA' },
      { degreeLevel: DegreeLevel.BACHELOR, studentId: otherStudent.id },
      { degreeLevel: DegreeLevel.BACHELOR, qualificationName: '   ' },
      { degreeLevel: DegreeLevel.BACHELOR, overallGrade: '' },
      { degreeLevel: DegreeLevel.BACHELOR, graduationYear: 0 },
      { degreeLevel: DegreeLevel.BACHELOR, graduationYear: -2020 },
      { degreeLevel: DegreeLevel.BACHELOR, graduationYear: nextYear },
      { degreeLevel: DegreeLevel.BACHELOR, graduationYear: '2024' },
      { degreeLevel: DegreeLevel.BACHELOR, graduationYear: 2024.5 },
      { degreeLevel: DegreeLevel.BACHELOR, institutionId: '1' },
      {
        degreeLevel: DegreeLevel.BACHELOR,
        equivalencyStatus: EquivalencyStatus.APPROVED,
      },
      {
        degreeLevel: DegreeLevel.BACHELOR,
        equivalencyStatus: EquivalencyStatus.APPROVED,
        equivalencyDecisionNumber: 'DEC-1',
      },
      {
        degreeLevel: DegreeLevel.BACHELOR,
        equivalencyStatus: EquivalencyStatus.APPROVED,
        equivalencyDecisionDate: getOfficeToday(),
      },
      {
        degreeLevel: DegreeLevel.BACHELOR,
        equivalencyStatus: EquivalencyStatus.APPROVED,
        equivalencyDecisionNumber: 'DEC-1',
        equivalencyDecisionDate: tomorrow,
      },
      {
        degreeLevel: DegreeLevel.BACHELOR,
        equivalencyStatus: EquivalencyStatus.REJECTED,
        equivalencyDecisionDate: '2023-02-29',
      },
      {
        degreeLevel: DegreeLevel.BACHELOR,
        equivalencyStatus: null,
      },
    ]) {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/students/${student.id}/qualifications`)
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send(badCreate)
        .expect(400);
      expect(res.body).toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    }

    // Cannot move qualification to another student, omit expectedVersion, send empty PATCH, or null non-nullable enums
    for (const badPatch of [
      { overallGrade: 'Good' },
      { expectedVersion: qual.version },
      { expectedVersion: qual.version, studentId: otherStudent.id },
      { expectedVersion: qual.version, degreeLevel: null },
      { expectedVersion: qual.version, equivalencyStatus: null },
    ]) {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/qualifications/${qual.id}`)
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send(badPatch)
        .expect(400);
      expect(res.body).toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    }

    await request(app.getHttpServer())
      .get(`/api/v1/qualifications/${qual.id}?includeArchived=yes`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(400);
    await request(app.getHttpServer())
      .get(
        `/api/v1/students/${student.id}/qualifications?includeArchivedStudent=yes`,
      )
      .set('Cookie', staffOne.sessionCookie)
      .expect(400);
  });

  it('supports equivalency transitions, independent archive/restore, archived-student blocking, stale versions, history, and no delete route', async () => {
    const student = await createStudent(
      'Lifecycle E2E Student',
      '00950505050505',
    );
    const today = getOfficeToday();

    const created = await createQualification(student.id, {
      degreeLevel: DegreeLevel.MASTER,
      qualificationName: 'M.Sc. Artificial Intelligence',
      equivalencyStatus: EquivalencyStatus.APPROVED,
      equivalencyDecisionNumber: 'EQ-2026/55',
      equivalencyDecisionDate: today,
    });

    // Status correction preserves existing decision details
    const pending = await patchJson<QualificationPayload>(
      `/api/v1/qualifications/${created.id}`,
      {
        expectedVersion: created.version,
        equivalencyStatus: EquivalencyStatus.PENDING,
      },
      staffTwo,
    );
    expect(pending).toMatchObject({
      equivalencyStatus: 'PENDING',
      equivalencyDecisionNumber: 'EQ-2026/55',
      equivalencyDecisionDate: today,
      version: 2,
    });

    // Stale version rejected with 409 STALE_VERSION
    const stale = await request(app.getHttpServer())
      .patch(`/api/v1/qualifications/${created.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: 1, overallGrade: 'Stale' })
      .expect(409);
    expect(stale.body).toMatchObject({ code: ERROR_CODES.STALE_VERSION });

    // Moving back to APPROVED reuses preserved details; clearing them while APPROVED fails
    const reApproved = await patchJson<QualificationPayload>(
      `/api/v1/qualifications/${created.id}`,
      {
        expectedVersion: pending.version,
        equivalencyStatus: EquivalencyStatus.APPROVED,
      },
    );
    expect(reApproved.version).toBe(3);

    await request(app.getHttpServer())
      .patch(`/api/v1/qualifications/${created.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({
        expectedVersion: reApproved.version,
        equivalencyDecisionNumber: null,
      })
      .expect(400);

    // Explicit clear when moving to REJECTED succeeds
    const rejected = await patchJson<QualificationPayload>(
      `/api/v1/qualifications/${created.id}`,
      {
        expectedVersion: reApproved.version,
        equivalencyStatus: EquivalencyStatus.REJECTED,
        equivalencyDecisionNumber: null,
        equivalencyDecisionDate: null,
      },
    );
    expect(rejected).toMatchObject({
      equivalencyStatus: 'REJECTED',
      equivalencyDecisionNumber: null,
      equivalencyDecisionDate: null,
      version: 4,
    });

    // Archive qualification independently
    const archivedQual = await postJson<QualificationPayload>(
      `/api/v1/qualifications/${created.id}/archive`,
      { expectedVersion: rejected.version },
      200,
    );
    expect(archivedQual.archivedAt).not.toBeNull();
    expect(archivedQual.version).toBe(5);

    // Hidden by default
    await request(app.getHttpServer())
      .get(`/api/v1/qualifications/${created.id}`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/qualifications/${created.id}/history`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(404);

    // Visible via explicit archive query
    const archivedList = await request(app.getHttpServer())
      .get(
        `/api/v1/students/${student.id}/qualifications?archiveStatus=ARCHIVED`,
      )
      .set('Cookie', staffTwo.sessionCookie)
      .expect(200);
    expect(
      (archivedList.body as { items: QualificationPayload[] }).items.map(
        (item) => item.id,
      ),
    ).toEqual([created.id]);

    // Archive student -> blocks qualification mutations and hides student qualifications by default
    const archivedStudent = await postJson<StudentPayload>(
      `/api/v1/students/${student.id}/archive`,
      { expectedVersion: student.version },
      200,
    );
    await request(app.getHttpServer())
      .get(`/api/v1/students/${student.id}/qualifications`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(
        `/api/v1/students/${student.id}/qualifications?archiveStatus=ALL&includeArchivedStudent=true`,
      )
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);

    const blockedCreate = await request(app.getHttpServer())
      .post(`/api/v1/students/${student.id}/qualifications`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ degreeLevel: DegreeLevel.BACHELOR })
      .expect(409);
    expect(blockedCreate.body).toMatchObject({
      code: ERROR_CODES.STUDENT_ARCHIVED,
    });

    const blockedRestore = await request(app.getHttpServer())
      .post(`/api/v1/qualifications/${created.id}/restore`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: archivedQual.version })
      .expect(409);
    expect(blockedRestore.body).toMatchObject({
      code: ERROR_CODES.STUDENT_ARCHIVED,
    });

    // Restoring student does NOT restore archived qualification
    await postJson<StudentPayload>(
      `/api/v1/students/${student.id}/restore`,
      { expectedVersion: archivedStudent.version },
      200,
    );
    await request(app.getHttpServer())
      .get(`/api/v1/qualifications/${created.id}`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(404);

    // Explicit qualification restore works and records staff attribution in newest-first history
    const restoredQual = await postJson<QualificationPayload>(
      `/api/v1/qualifications/${created.id}/restore`,
      { expectedVersion: archivedQual.version },
      200,
      staffTwo,
    );
    expect(restoredQual).toMatchObject({
      archivedAt: null,
      version: 6,
    });

    const historyRes = await request(app.getHttpServer())
      .get(`/api/v1/qualifications/${created.id}/history`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    const historyBody = historyRes.body as {
      items: HistoryPayload[];
      total: number;
    };
    expect(historyBody.total).toBe(6);
    expect(historyBody.items.map((item) => item.action)).toEqual([
      'RESTORED',
      'ARCHIVED',
      'UPDATED',
      'UPDATED',
      'UPDATED',
      'CREATED',
    ]);
    expect(historyBody.items[0].staffUser?.id).toBe(staffTwo.user.id);

    // No permanent qualification deletion
    await request(app.getHttpServer())
      .delete(`/api/v1/qualifications/${created.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .expect(404);
  });

  it('publishes all qualification routes and DTO schemas in OpenAPI with error mappings and no delete route', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    const doc = response.body as OpenApiDocument;

    for (const [path, methods] of [
      ['/api/v1/students/{studentId}/qualifications', ['get', 'post']],
      ['/api/v1/qualifications/{id}', ['get', 'patch']],
      ['/api/v1/qualifications/{id}/archive', ['post']],
      ['/api/v1/qualifications/{id}/restore', ['post']],
      ['/api/v1/qualifications/{id}/history', ['get']],
    ] as const) {
      expect(doc.paths[path]).toBeDefined();
      for (const method of methods) {
        expect(doc.paths[path][method]).toBeDefined();
        for (const status of ['400', '401', '403', '404', '409']) {
          expect(doc.paths[path][method].responses?.[status]).toBeDefined();
        }
      }
    }

    expect(doc.paths['/api/v1/qualifications/{id}']?.delete).toBeUndefined();

    const qualSchema = doc.components.schemas['QualificationDto'];
    expect(qualSchema).toBeDefined();
    for (const field of [
      'id',
      'studentId',
      'degreeLevel',
      'qualificationName',
      'institutionId',
      'facultyId',
      'departmentId',
      'graduationYear',
      'overallGrade',
      'equivalencyStatus',
      'equivalencyDecisionNumber',
      'equivalencyDecisionDate',
      'archivedAt',
      'version',
      'createdAt',
      'updatedAt',
    ]) {
      expect(qualSchema.properties).toHaveProperty(field);
    }
  });
});
