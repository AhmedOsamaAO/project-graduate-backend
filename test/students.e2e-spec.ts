import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createApplication } from '../src/bootstrap';
import {
  formatCalendarDate,
  getOfficeToday,
  parseCalendarDate,
} from '../src/common/dates/office-calendar';
import { ERROR_CODES } from '../src/common/errors/error-codes';
import { MilitaryStatus } from '../src/generated/prisma/client';
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
  fullName: string;
  nationalId: string;
  phone: string | null;
  birthDate: string | null;
  address: string | null;
  militaryStatus: MilitaryStatus | null;
  selectedPhotoDocumentId: number | null;
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

describe('students HTTP API (e2e)', () => {
  let app: INestApplication<App>;
  let environment: TestEnvironment;
  let staffOne: SignedInStaff;
  let staffTwo: SignedInStaff;

  beforeAll(async () => {
    environment = await createTestEnvironment();
    app = (await createApplication()) as INestApplication<App>;
    staffOne = await provisionAndLogin(app, {
      username: 'students.staff.one',
      fullName: 'Students Staff One',
    });
    staffTwo = await provisionAndLogin(app, {
      username: 'students.staff.two',
      fullName: 'Students Staff Two',
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

  async function postStudent(
    payload: Record<string, unknown>,
    staff = staffOne,
  ): Promise<StudentPayload> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/students')
      .set('Origin', staff.origin)
      .set('Cookie', staff.sessionCookie)
      .set('X-CSRF-Token', staff.csrfToken)
      .send(payload)
      .expect(201);
    return (response.body as { data: StudentPayload }).data;
  }

  async function patchStudent(
    id: number,
    payload: Record<string, unknown>,
    staff = staffOne,
  ): Promise<StudentPayload> {
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/students/${id}`)
      .set('Origin', staff.origin)
      .set('Cookie', staff.sessionCookie)
      .set('X-CSRF-Token', staff.csrfToken)
      .send(payload)
      .expect(200);
    return (response.body as { data: StudentPayload }).data;
  }

  async function postVersionAction(
    path: string,
    expectedVersion: number,
    staff = staffOne,
  ): Promise<StudentPayload> {
    const response = await request(app.getHttpServer())
      .post(path)
      .set('Origin', staff.origin)
      .set('Cookie', staff.sessionCookie)
      .set('X-CSRF-Token', staff.csrfToken)
      .send({ expectedVersion })
      .expect(200);
    return (response.body as { data: StudentPayload }).data;
  }

  it('rejects unauthenticated requests on all student routes and leaks nothing for archived IDs', async () => {
    const created = await postStudent({
      fullName: 'Unauth Visibility Target',
      nationalId: '00101010101010',
    });
    const archived = await postVersionAction(
      `/api/v1/students/${created.id}/archive`,
      created.version,
    );

    for (const makeRequest of [
      () => request(app.getHttpServer()).get('/api/v1/students'),
      () =>
        request(app.getHttpServer()).get('/api/v1/students?archiveStatus=ALL'),
      () => request(app.getHttpServer()).get(`/api/v1/students/${archived.id}`),
      () =>
        request(app.getHttpServer()).get(
          `/api/v1/students/${archived.id}?includeArchived=true`,
        ),
      () =>
        request(app.getHttpServer()).get(
          `/api/v1/students/${archived.id}/history`,
        ),
      () =>
        request(app.getHttpServer()).get(
          `/api/v1/students/${archived.id}/history?includeArchived=true`,
        ),
      () =>
        request(app.getHttpServer())
          .post('/api/v1/students')
          .set('Origin', staffOne.origin)
          .send({
            fullName: 'Probe Archived',
            nationalId: '00101010101010',
          }),
      () =>
        request(app.getHttpServer())
          .patch(`/api/v1/students/${archived.id}`)
          .set('Origin', staffOne.origin)
          .send({ expectedVersion: archived.version, fullName: 'Probe' }),
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/students/${archived.id}/archive`)
          .set('Origin', staffOne.origin)
          .send({ expectedVersion: archived.version }),
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/students/${archived.id}/restore`)
          .set('Origin', staffOne.origin)
          .send({ expectedVersion: archived.version }),
    ]) {
      const response = await makeRequest().expect(401);
      expect(response.body).toEqual({
        code: ERROR_CODES.UNAUTHENTICATED,
        message: 'Authentication required',
      });
    }
  });

  it('enforces Origin and CSRF protection on all state-changing student endpoints', async () => {
    const created = await postStudent({
      fullName: 'CSRF Check Student',
      nationalId: '00202020202020',
    });

    for (const makeRequest of [
      () =>
        request(app.getHttpServer())
          .post('/api/v1/students')
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .send({ fullName: 'Blocked', nationalId: '00202020202021' }),
      () =>
        request(app.getHttpServer())
          .patch(`/api/v1/students/${created.id}`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .send({ expectedVersion: created.version, phone: '01011112222' }),
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/students/${created.id}/archive`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .send({ expectedVersion: created.version }),
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/students/${created.id}/restore`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .send({ expectedVersion: created.version }),
    ]) {
      const res = await makeRequest().expect(403);
      expect(res.body).toMatchObject({ code: ERROR_CODES.CSRF_INVALID });
    }

    const badOrigin = await request(app.getHttpServer())
      .post('/api/v1/students')
      .set('Origin', 'http://untrusted.example')
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ fullName: 'Blocked Origin', nationalId: '00202020202022' })
      .expect(403);
    expect(badOrigin.body).toMatchObject({
      code: ERROR_CODES.ORIGIN_NOT_ALLOWED,
    });
  });

  it('creates minimal and full student records, normalizes Arabic-Indic digits, and preserves leading zeros', async () => {
    const minimal = await postStudent({
      fullName: '  أحمد  ',
      nationalId: '  ٠٠١٢٣٤٥٦٧٨٩٠١٢  ',
    });

    expect(minimal).toMatchObject({
      fullName: 'أحمد',
      nationalId: '00123456789012',
      phone: null,
      birthDate: null,
      address: null,
      militaryStatus: null,
      selectedPhotoDocumentId: null,
      archivedAt: null,
      version: 1,
    });
    expect(minimal).not.toHaveProperty('degreeLevel');
    expect(minimal).not.toHaveProperty('degreeName');
    expect(minimal).not.toHaveProperty('graduateDepartmentId');

    const full = await postStudent({
      fullName: '  Sara Ali Hassan  ',
      nationalId: '00000000000001',
      phone: '  01098765432  ',
      birthDate: '1999-05-14',
      address: '  12 University St, Zagazig  ',
      militaryStatus: MilitaryStatus.EXEMPTED,
    });

    expect(full).toMatchObject({
      fullName: 'Sara Ali Hassan',
      nationalId: '00000000000001',
      phone: '01098765432',
      birthDate: '1999-05-14',
      address: '12 University St, Zagazig',
      militaryStatus: 'EXEMPTED',
      selectedPhotoDocumentId: null,
      archivedAt: null,
      version: 1,
    });
  });

  it('rejects invalid input, future Cairo dates, forbidden extra fields, and missing expectedVersion', async () => {
    const valid = await postStudent({
      fullName: 'Validation Target',
      nationalId: '00303030303030',
    });

    for (const payload of [
      { fullName: 'Numeric ID', nationalId: 30303030303031 },
      { fullName: 'Short ID', nationalId: '1234567890123' },
      { fullName: 'Long ID', nationalId: '123456789012345' },
      { fullName: 'Dashed ID', nationalId: '3030303-030303' },
      { fullName: 'Spaced ID', nationalId: '3030303 030303' },
      { fullName: '   ', nationalId: '00303030303031' },
      {
        fullName: 'Bad Leap Date',
        nationalId: '00303030303032',
        birthDate: '2023-02-29',
      },
      {
        fullName: 'Bad Calendar Day',
        nationalId: '00303030303033',
        birthDate: '2024-02-30',
      },
      {
        fullName: 'Future Cairo Birth Date',
        nationalId: '00303030303034',
        birthDate: nextOfficeDate(),
      },
      {
        fullName: 'Mixed Case Military',
        nationalId: '00303030303035',
        militaryStatus: 'Completed',
      },
      {
        fullName: 'Empty Phone',
        nationalId: '00303030303036',
        phone: '   ',
      },
      {
        fullName: 'Empty Address',
        nationalId: '00303030303037',
        address: '',
      },
      {
        fullName: 'Disallowed Degree Field',
        nationalId: '00303030303038',
        degreeLevel: 'BACHELOR',
      },
      {
        fullName: 'Disallowed Dept Field',
        nationalId: '00303030303039',
        graduateDepartmentId: 1,
      },
      {
        fullName: 'Disallowed Photo Field',
        nationalId: '00303030303040',
        selectedPhotoDocumentId: 1,
      },
    ]) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/students')
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send(payload)
        .expect(400);
      expect(res.body).toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    }

    for (const patchPayload of [
      { fullName: 'Missing Version' },
      { expectedVersion: valid.version },
      { expectedVersion: valid.version, fullName: null },
      { expectedVersion: valid.version, nationalId: null },
    ]) {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/students/${valid.id}`)
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send(patchPayload)
        .expect(400);
      expect(res.body).toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    }

    await request(app.getHttpServer())
      .get(`/api/v1/students/${valid.id}?includeArchived=yes`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(400);
  });

  it('supports typed search, filters, leading-zero preservation, pagination, and deterministic sorting', async () => {
    const s1 = await postStudent({
      fullName: 'Zainab Search Alpha',
      nationalId: '00881122334455',
      militaryStatus: MilitaryStatus.EXEMPTED,
    });
    const s2 = await postStudent({
      fullName: 'Amr Search Beta',
      nationalId: '11881122334455',
      militaryStatus: MilitaryStatus.POSTPONED,
    });

    const prefixZeroRes = await request(app.getHttpServer())
      .get('/api/v1/students?nationalId=0088')
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect(
      (prefixZeroRes.body as { items: StudentPayload[] }).items.map(
        (item) => item.id,
      ),
    ).toEqual([s1.id]);

    const arabicDigitSearch = await request(app.getHttpServer())
      .get('/api/v1/students?search=' + encodeURIComponent('٠٠٨٨١١'))
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect(
      (arabicDigitSearch.body as { items: StudentPayload[] }).items.map(
        (item) => item.id,
      ),
    ).toEqual([s1.id]);

    const nameSearch = await request(app.getHttpServer())
      .get('/api/v1/students?fullName=Search%20Beta&militaryStatus=POSTPONED')
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect(
      (nameSearch.body as { items: StudentPayload[] }).items.map(
        (item) => item.id,
      ),
    ).toEqual([s2.id]);

    const pagedSorted = await request(app.getHttpServer())
      .get(
        '/api/v1/students?fullName=Search&sortBy=fullName&sortOrder=desc&page=1&pageSize=1',
      )
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    expect(pagedSorted.body).toMatchObject({
      total: 2,
      page: 1,
      pageSize: 1,
      items: [{ id: s1.id }],
    });
  });

  it('supports updating, archiving, archived-ID conflict details, restoring with history, and has no delete route', async () => {
    const created = await postStudent({
      fullName: 'Archive Lifecycle Student',
      nationalId: '00556677889900',
      phone: '01012345678',
      birthDate: '1998-08-20',
      address: 'Zagazig',
      militaryStatus: MilitaryStatus.COMPLETED,
    });

    // Update including correcting mistyped nationalId and clearing optional fields
    const updated = await patchStudent(
      created.id,
      {
        expectedVersion: created.version,
        nationalId: '٠٠٥٥٦٦٧٧٨٨٩٩٠١',
        phone: null,
        address: null,
      },
      staffTwo,
    );
    expect(updated).toMatchObject({
      nationalId: '00556677889901',
      phone: null,
      address: null,
      version: 2,
    });

    // Stale version fails
    const staleRes = await request(app.getHttpServer())
      .patch(`/api/v1/students/${created.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: 1, fullName: 'Stale' })
      .expect(409);
    expect(staleRes.body).toMatchObject({ code: ERROR_CODES.STALE_VERSION });

    // Archive
    const archived = await postVersionAction(
      `/api/v1/students/${created.id}/archive`,
      updated.version,
    );
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.version).toBe(3);

    // Default lookups return 404 or omit archived student
    await request(app.getHttpServer())
      .get(`/api/v1/students/${created.id}`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/students/${created.id}/history`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(404);

    // Explicit archive queries succeed
    const archivedList = await request(app.getHttpServer())
      .get('/api/v1/students?archiveStatus=ARCHIVED&nationalId=00556677889901')
      .set('Cookie', staffTwo.sessionCookie)
      .expect(200);
    expect(
      (archivedList.body as { items: StudentPayload[] }).items.map(
        (item) => item.id,
      ),
    ).toEqual([created.id]);

    await request(app.getHttpServer())
      .get(`/api/v1/students/${created.id}?includeArchived=true`)
      .set('Cookie', staffTwo.sessionCookie)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/students/${created.id}/history?includeArchived=false`)
      .set('Cookie', staffTwo.sessionCookie)
      .expect(404);
    const archivedHistoryRes = await request(app.getHttpServer())
      .get(`/api/v1/students/${created.id}/history?includeArchived=true`)
      .set('Cookie', staffTwo.sessionCookie)
      .expect(200);
    expect((archivedHistoryRes.body as { total: number }).total).toBe(3);

    // Editing archived student is blocked
    const editArchived = await request(app.getHttpServer())
      .patch(`/api/v1/students/${created.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .send({ expectedVersion: archived.version, phone: '01000000000' })
      .expect(409);
    expect(editArchived.body).toMatchObject({
      code: ERROR_CODES.STUDENT_ARCHIVED,
    });

    // Creating with archived student's national ID returns conflict identifying archived student
    const conflictRes = await request(app.getHttpServer())
      .post('/api/v1/students')
      .set('Origin', staffTwo.origin)
      .set('Cookie', staffTwo.sessionCookie)
      .set('X-CSRF-Token', staffTwo.csrfToken)
      .send({
        fullName: 'Returning Student',
        nationalId: '00556677889901',
      })
      .expect(409);
    expect(conflictRes.body).toMatchObject({
      code: ERROR_CODES.STUDENT_NATIONAL_ID_ARCHIVED,
      details: {
        studentId: created.id,
        fullName: 'Archive Lifecycle Student',
        nationalId: '00556677889901',
        archivedAt: archived.archivedAt,
        version: archived.version,
        requiresRestore: true,
      },
    });

    // Restore preserves identity and full history
    const restored = await postVersionAction(
      `/api/v1/students/${created.id}/restore`,
      archived.version,
      staffTwo,
    );
    expect(restored).toMatchObject({
      id: created.id,
      nationalId: '00556677889901',
      archivedAt: null,
      version: 4,
    });

    const historyRes = await request(app.getHttpServer())
      .get(`/api/v1/students/${created.id}/history`)
      .set('Cookie', staffOne.sessionCookie)
      .expect(200);
    const historyBody = historyRes.body as {
      items: HistoryPayload[];
      total: number;
    };
    expect(historyBody.total).toBe(4);
    expect(historyBody.items.map((item) => item.action)).toEqual([
      'RESTORED',
      'ARCHIVED',
      'UPDATED',
      'CREATED',
    ]);
    expect(historyBody.items[0].staffUser?.id).toBe(staffTwo.user.id);

    // Permanent deletion is not available
    await request(app.getHttpServer())
      .delete(`/api/v1/students/${created.id}`)
      .set('Origin', staffOne.origin)
      .set('Cookie', staffOne.sessionCookie)
      .set('X-CSRF-Token', staffOne.csrfToken)
      .expect(404);
  });

  it('publishes all student and history routes and DTO schemas in OpenAPI without degree or department fields', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    const doc = response.body as OpenApiDocument;

    for (const [path, methods] of [
      ['/api/v1/students', ['get', 'post']],
      ['/api/v1/students/{id}', ['get', 'patch']],
      ['/api/v1/students/{id}/archive', ['post']],
      ['/api/v1/students/{id}/restore', ['post']],
      ['/api/v1/students/{id}/history', ['get']],
    ] as const) {
      expect(doc.paths[path]).toBeDefined();
      for (const method of methods) {
        expect(doc.paths[path][method]).toBeDefined();
        for (const status of ['400', '401', '403', '404', '409']) {
          expect(doc.paths[path][method].responses?.[status]).toBeDefined();
        }
      }
    }

    expect(doc.paths['/api/v1/students/{id}']?.delete).toBeUndefined();

    const studentSchema = doc.components.schemas['StudentDto'];
    expect(studentSchema).toBeDefined();
    expect(studentSchema.properties).not.toHaveProperty('degreeLevel');
    expect(studentSchema.properties).not.toHaveProperty('degreeName');
    expect(studentSchema.properties).not.toHaveProperty('graduateDepartmentId');
    expect(studentSchema.properties).not.toHaveProperty('photoUrl');
    expect(studentSchema.properties).not.toHaveProperty('deletedAt');
  });
});
