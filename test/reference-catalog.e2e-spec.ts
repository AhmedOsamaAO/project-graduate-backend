import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createApplication } from '../src/bootstrap';
import type { ErrorEnvelope } from '../src/common/errors/error-codes';
import { loadAppConfig } from '../src/config/app-config';
import { FIXED_OFFICE } from '../src/reference-data/fixed-office';
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
    schemas: Record<string, unknown>;
  };
}

interface InstitutionPayload {
  id: number;
  name: string;
  institutionType: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface FacultyPayload {
  id: number;
  institutionId: number;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface DepartmentPayload {
  id: number;
  facultyId: number;
  name: string;
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

describe('reference catalog and fixed office (e2e)', () => {
  describe('authenticated HTTP surface', () => {
    let app: INestApplication<App>;
    let environment: TestEnvironment;
    let staffOne: SignedInStaff;
    let staffTwo: SignedInStaff;

    beforeAll(async () => {
      environment = await createTestEnvironment();
      app = (await createApplication()) as INestApplication<App>;
      staffOne = await provisionAndLogin(app, {
        username: 'catalog.staff.one',
        fullName: 'Catalog Staff One',
      });
      staffTwo = await provisionAndLogin(app, {
        username: 'catalog.staff.two',
        fullName: 'Catalog Staff Two',
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

    async function postResource<T>(
      path: string,
      payload: Record<string, unknown>,
      staff = staffOne,
    ): Promise<T> {
      const response = await request(app.getHttpServer())
        .post(path)
        .set('Origin', staff.origin)
        .set('Cookie', staff.sessionCookie)
        .set('X-CSRF-Token', staff.csrfToken)
        .send(payload)
        .expect(201);
      return (response.body as { data: T }).data;
    }

    async function patchResource<T>(
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

    async function deleteResource(
      path: string,
      expectedVersion: number,
      staff = staffOne,
    ): Promise<void> {
      await request(app.getHttpServer())
        .delete(`${path}?expectedVersion=${expectedVersion}`)
        .set('Origin', staff.origin)
        .set('Cookie', staff.sessionCookie)
        .set('X-CSRF-Token', staff.csrfToken)
        .expect(204);
    }

    it('rejects unauthenticated requests on all catalog and history endpoints', async () => {
      for (const makeRequest of [
        () => request(app.getHttpServer()).get('/api/v1/institutions'),
        () => request(app.getHttpServer()).get('/api/v1/institutions/1'),
        () =>
          request(app.getHttpServer()).get('/api/v1/institutions/1/history'),
        () =>
          request(app.getHttpServer())
            .post('/api/v1/institutions')
            .set('Origin', staffOne.origin)
            .send({ name: 'Test', institutionType: 'OTHER' }),
        () =>
          request(app.getHttpServer())
            .patch('/api/v1/institutions/1')
            .set('Origin', staffOne.origin)
            .send({ expectedVersion: 1, name: 'Test' }),
        () =>
          request(app.getHttpServer())
            .delete('/api/v1/institutions/1?expectedVersion=1')
            .set('Origin', staffOne.origin),
        () => request(app.getHttpServer()).get('/api/v1/faculties'),
        () => request(app.getHttpServer()).get('/api/v1/faculties/1'),
        () => request(app.getHttpServer()).get('/api/v1/faculties/1/history'),
        () =>
          request(app.getHttpServer())
            .post('/api/v1/faculties')
            .set('Origin', staffOne.origin)
            .send({ institutionId: 1, name: 'Test' }),
        () => request(app.getHttpServer()).get('/api/v1/departments'),
        () => request(app.getHttpServer()).get('/api/v1/departments/1'),
        () => request(app.getHttpServer()).get('/api/v1/departments/1/history'),
        () =>
          request(app.getHttpServer())
            .post('/api/v1/departments')
            .set('Origin', staffOne.origin)
            .send({ facultyId: 1, name: 'Test' }),
      ]) {
        const res = await makeRequest().expect(401);
        expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
      }
    });

    it('enforces Origin and CSRF protection on state-changing catalog routes', async () => {
      const noCsrf = await request(app.getHttpServer())
        .post('/api/v1/institutions')
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .send({ name: 'Blocked Univ', institutionType: 'OTHER' })
        .expect(403);
      expect(noCsrf.body).toMatchObject({ code: 'CSRF_INVALID' });

      const badOrigin = await request(app.getHttpServer())
        .delete('/api/v1/institutions/1?expectedVersion=1')
        .set('Origin', 'http://untrusted.example')
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .expect(403);
      expect(badOrigin.body).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
    });

    it('serves the pre-provisioned fixed office hierarchy and blocks mutating or deleting fixed rows', async () => {
      const instRes = await request(app.getHttpServer())
        .get(`/api/v1/institutions/${FIXED_OFFICE.institution.id}`)
        .set('Cookie', staffOne.sessionCookie)
        .expect(200);
      const instData = (instRes.body as { data: InstitutionPayload }).data;
      expect(instData).toMatchObject({
        id: 1,
        name: 'Zagazig University',
        institutionType: 'PUBLIC_UNIVERSITY',
        version: 1,
      });
      expect(instData).not.toHaveProperty('isFixedOffice');

      const facRes = await request(app.getHttpServer())
        .get(`/api/v1/faculties/${FIXED_OFFICE.faculty.id}`)
        .set('Cookie', staffOne.sessionCookie)
        .expect(200);
      const facData = (facRes.body as { data: FacultyPayload }).data;
      expect(facData).toMatchObject({
        id: 1,
        institutionId: 1,
        name: 'Faculty of Computer and Information',
        version: 1,
      });
      expect(facData).not.toHaveProperty('isFixedOffice');

      const fixedHistory = await request(app.getHttpServer())
        .get('/api/v1/institutions/1/history')
        .set('Cookie', staffTwo.sessionCookie)
        .expect(200);
      expect(fixedHistory.body).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
      });

      const patchInst = await request(app.getHttpServer())
        .patch('/api/v1/institutions/1')
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send({ expectedVersion: 1, name: 'Repurposed' })
        .expect(409);
      expect(patchInst.body).toMatchObject({ code: 'FIXED_RECORD_PROTECTED' });

      const delInst = await request(app.getHttpServer())
        .delete('/api/v1/institutions/1?expectedVersion=1')
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .expect(409);
      expect(delInst.body).toMatchObject({ code: 'FIXED_RECORD_PROTECTED' });

      const patchFac = await request(app.getHttpServer())
        .patch('/api/v1/faculties/1')
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send({ expectedVersion: 1, name: 'Repurposed Faculty' })
        .expect(409);
      expect(patchFac.body).toMatchObject({ code: 'FIXED_RECORD_PROTECTED' });

      const delFac = await request(app.getHttpServer())
        .delete('/api/v1/faculties/1?expectedVersion=1')
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .expect(409);
      expect(delFac.body).toMatchObject({ code: 'FIXED_RECORD_PROTECTED' });
    });

    it('creates, searches literally for LIKE wildcards, filters, sorts, and updates institutions with version checks', async () => {
      const instA = await postResource<InstitutionPayload>(
        '/api/v1/institutions',
        {
          name: '  Cairo University  ',
          institutionType: 'PUBLIC_UNIVERSITY',
        },
      );
      expect(instA.name).toBe('Cairo University');
      expect(instA).not.toHaveProperty('isFixedOffice');
      expect(instA.version).toBe(1);
      let instAVersion = instA.version;

      const instB = await postResource<InstitutionPayload>(
        '/api/v1/institutions',
        {
          name: 'Institute 100% _Special',
          institutionType: 'PRIVATE_INSTITUTE',
        },
      );

      try {
        const percentSearch = await request(app.getHttpServer())
          .get('/api/v1/institutions')
          .query({ search: '100% _' })
          .set('Cookie', staffOne.sessionCookie)
          .expect(200);
        expect(
          (percentSearch.body as { items: InstitutionPayload[] }).items.map(
            (i) => i.id,
          ),
        ).toEqual([instB.id]);

        const filteredInst = await request(app.getHttpServer())
          .get('/api/v1/institutions')
          .query({
            institutionType: 'PUBLIC_UNIVERSITY',
            sortBy: 'name',
            sortOrder: 'desc',
          })
          .set('Cookie', staffOne.sessionCookie)
          .expect(200);
        expect(
          (filteredInst.body as { items: InstitutionPayload[] }).items.map(
            (i) => i.name,
          ),
        ).toEqual(['Zagazig University', 'Cairo University']);

        const updatedInstA = await patchResource<InstitutionPayload>(
          `/api/v1/institutions/${instA.id}`,
          { expectedVersion: 1, name: 'Cairo University Updated' },
          staffTwo,
        );
        instAVersion = updatedInstA.version;
        expect(updatedInstA.version).toBe(2);

        const staleInst = await request(app.getHttpServer())
          .patch(`/api/v1/institutions/${instA.id}`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .set('X-CSRF-Token', staffOne.csrfToken)
          .send({ expectedVersion: 1, name: 'Stale Name' })
          .expect(409);
        expect(staleInst.body).toMatchObject({ code: 'STALE_VERSION' });
      } finally {
        await deleteResource(
          `/api/v1/institutions/${instA.id}`,
          instAVersion,
        ).catch(() => undefined);
        await deleteResource(
          `/api/v1/institutions/${instB.id}`,
          instB.version,
        ).catch(() => undefined);
      }
    });

    it('enforces faculty uniqueness per institution and deterministic name-plus-id sorting', async () => {
      const instA = await postResource<InstitutionPayload>(
        '/api/v1/institutions',
        { name: 'Faculty Uniq Univ A', institutionType: 'PUBLIC_UNIVERSITY' },
      );
      const instB = await postResource<InstitutionPayload>(
        '/api/v1/institutions',
        { name: 'Faculty Uniq Univ B', institutionType: 'PRIVATE_INSTITUTE' },
      );
      let facA: FacultyPayload | null = null;
      let facB: FacultyPayload | null = null;

      try {
        facA = await postResource<FacultyPayload>('/api/v1/faculties', {
          institutionId: instA.id,
          name: 'Faculty of Engineering',
        });
        expect(facA).not.toHaveProperty('isFixedOffice');

        const dupFac = await request(app.getHttpServer())
          .post('/api/v1/faculties')
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .set('X-CSRF-Token', staffOne.csrfToken)
          .send({
            institutionId: instA.id,
            name: 'Faculty of Engineering',
          })
          .expect(409);
        expect(dupFac.body).toMatchObject({ code: 'FACULTY_NAME_EXISTS' });

        facB = await postResource<FacultyPayload>('/api/v1/faculties', {
          institutionId: instB.id,
          name: 'Faculty of Engineering',
        });

        const listedFac = await request(app.getHttpServer())
          .get('/api/v1/faculties')
          .query({ search: 'Engineering', sortBy: 'name', sortOrder: 'asc' })
          .set('Cookie', staffOne.sessionCookie)
          .expect(200);
        expect(
          (listedFac.body as { items: FacultyPayload[] }).items.map(
            (f) => f.id,
          ),
        ).toEqual([facA.id, facB.id]);
      } finally {
        if (facA) {
          await deleteResource(`/api/v1/faculties/${facA.id}`, facA.version);
        }
        if (facB) {
          await deleteResource(`/api/v1/faculties/${facB.id}`, facB.version);
        }
        await deleteResource(`/api/v1/institutions/${instA.id}`, instA.version);
        await deleteResource(`/api/v1/institutions/${instB.id}`, instB.version);
      }
    });

    it('allows reparenting an unreferenced non-fixed faculty and blocks reparenting or deleting a referenced faculty', async () => {
      const instA = await postResource<InstitutionPayload>(
        '/api/v1/institutions',
        { name: 'E2E Reparent Source', institutionType: 'PUBLIC_UNIVERSITY' },
      );
      const instB = await postResource<InstitutionPayload>(
        '/api/v1/institutions',
        { name: 'E2E Reparent Target', institutionType: 'PRIVATE_UNIVERSITY' },
      );
      let fac = await postResource<FacultyPayload>('/api/v1/faculties', {
        institutionId: instA.id,
        name: 'Faculty of Sciences',
      });
      let dept: DepartmentPayload | null = null;

      try {
        fac = await patchResource<FacultyPayload>(
          `/api/v1/faculties/${fac.id}`,
          { expectedVersion: fac.version, institutionId: instB.id },
        );
        expect(fac.institutionId).toBe(instB.id);
        expect(fac.version).toBe(2);

        dept = await postResource<DepartmentPayload>('/api/v1/departments', {
          facultyId: fac.id,
          name: 'Mathematics',
        });

        const blockedReparent = await request(app.getHttpServer())
          .patch(`/api/v1/faculties/${fac.id}`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .set('X-CSRF-Token', staffOne.csrfToken)
          .send({ expectedVersion: fac.version, institutionId: instA.id })
          .expect(409);
        expect(blockedReparent.body).toMatchObject({ code: 'RECORD_IN_USE' });

        fac = await patchResource<FacultyPayload>(
          `/api/v1/faculties/${fac.id}`,
          {
            expectedVersion: fac.version,
            name: 'Faculty of Applied Sciences',
          },
        );
        expect(fac.version).toBe(3);
        expect(fac.institutionId).toBe(instB.id);

        const inUseDelete = await request(app.getHttpServer())
          .delete(`/api/v1/faculties/${fac.id}?expectedVersion=${fac.version}`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .set('X-CSRF-Token', staffOne.csrfToken)
          .expect(409);
        expect(inUseDelete.body).toMatchObject({ code: 'RECORD_IN_USE' });

        await deleteResource(`/api/v1/departments/${dept.id}`, dept.version);
        dept = null;

        fac = await patchResource<FacultyPayload>(
          `/api/v1/faculties/${fac.id}`,
          { expectedVersion: fac.version, institutionId: instA.id },
        );
        expect(fac.institutionId).toBe(instA.id);
        expect(fac.version).toBe(4);
      } finally {
        if (dept) {
          await deleteResource(`/api/v1/departments/${dept.id}`, dept.version);
        }
        await deleteResource(`/api/v1/faculties/${fac.id}`, fac.version);
        await deleteResource(`/api/v1/institutions/${instB.id}`, instB.version);
        await deleteResource(`/api/v1/institutions/${instA.id}`, instA.version);
      }
    });

    it('manages departments under fixed and non-fixed faculties with uniqueness and institution filtering', async () => {
      const inst = await postResource<InstitutionPayload>(
        '/api/v1/institutions',
        { name: 'Dept Test Univ', institutionType: 'PUBLIC_UNIVERSITY' },
      );
      const fac = await postResource<FacultyPayload>('/api/v1/faculties', {
        institutionId: inst.id,
        name: 'Faculty of Computing',
      });
      const deptFixed = await postResource<DepartmentPayload>(
        '/api/v1/departments',
        {
          facultyId: FIXED_OFFICE.faculty.id,
          name: 'Computer Science',
        },
      );
      let deptA = await postResource<DepartmentPayload>('/api/v1/departments', {
        facultyId: fac.id,
        name: 'Systems Engineering',
      });

      try {
        const dupDept = await request(app.getHttpServer())
          .post('/api/v1/departments')
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .set('X-CSRF-Token', staffOne.csrfToken)
          .send({
            facultyId: fac.id,
            name: 'Systems Engineering',
          })
          .expect(409);
        expect(dupDept.body).toMatchObject({ code: 'DEPARTMENT_NAME_EXISTS' });

        const filteredDepts = await request(app.getHttpServer())
          .get('/api/v1/departments')
          .query({ institutionId: FIXED_OFFICE.institution.id })
          .set('Cookie', staffTwo.sessionCookie)
          .expect(200);
        expect(
          (filteredDepts.body as { items: DepartmentPayload[] }).items.map(
            (d) => d.id,
          ),
        ).toEqual([deptFixed.id]);

        deptA = await patchResource<DepartmentPayload>(
          `/api/v1/departments/${deptA.id}`,
          { expectedVersion: 1, name: 'Computer Engineering' },
          staffTwo,
        );
        expect(deptA.version).toBe(2);
      } finally {
        await deleteResource(
          `/api/v1/departments/${deptFixed.id}`,
          deptFixed.version,
        );
        await deleteResource(`/api/v1/departments/${deptA.id}`, deptA.version);
        await deleteResource(`/api/v1/faculties/${fac.id}`, fac.version);
        await deleteResource(`/api/v1/institutions/${inst.id}`, inst.version);
      }
    });

    it('serves newest-first paged read-only change history including deleted entries without leaking secrets', async () => {
      const inst = await postResource<InstitutionPayload>(
        '/api/v1/institutions',
        { name: 'History Target Univ', institutionType: 'PUBLIC_UNIVERSITY' },
      );
      const updated = await patchResource<InstitutionPayload>(
        `/api/v1/institutions/${inst.id}`,
        { expectedVersion: 1, name: 'History Target Univ Updated' },
        staffTwo,
      );
      await deleteResource(
        `/api/v1/institutions/${inst.id}`,
        updated.version,
        staffTwo,
      );

      await request(app.getHttpServer())
        .get(`/api/v1/institutions/${inst.id}`)
        .set('Cookie', staffOne.sessionCookie)
        .expect(404);

      const instOther = await postResource<InstitutionPayload>(
        '/api/v1/institutions',
        { name: 'Read Only History Probe', institutionType: 'OTHER' },
      );

      try {
        const historyPage1 = await request(app.getHttpServer())
          .get(`/api/v1/institutions/${inst.id}/history`)
          .query({ page: 1, pageSize: 2 })
          .set('Cookie', staffOne.sessionCookie)
          .expect(200);
        const page1Body = historyPage1.body as {
          items: HistoryPayload[];
          total: number;
          page: number;
          pageSize: number;
        };
        expect(page1Body.total).toBe(3);
        expect(page1Body.page).toBe(1);
        expect(page1Body.pageSize).toBe(2);
        expect(page1Body.items.map((item) => item.action)).toEqual([
          'DELETED',
          'UPDATED',
        ]);
        expect(page1Body.items[0]).toMatchObject({
          recordType: 'EDUCATIONAL_INSTITUTION',
          recordId: inst.id,
          action: 'DELETED',
          actorKind: 'STAFF',
          staffUser: {
            id: staffTwo.user.id,
            username: staffTwo.user.username,
            fullName: staffTwo.user.fullName,
          },
          after: null,
        });
        expect(JSON.stringify(page1Body)).not.toMatch(
          /passwordHash|csrfSecret|credentialDigest|operationCorrelation/,
        );

        const historyPage2 = await request(app.getHttpServer())
          .get(`/api/v1/institutions/${inst.id}/history`)
          .query({ page: 2, pageSize: 2 })
          .set('Cookie', staffTwo.sessionCookie)
          .expect(200);
        const page2Body = historyPage2.body as { items: HistoryPayload[] };
        expect(page2Body.items.map((item) => item.action)).toEqual(['CREATED']);

        await request(app.getHttpServer())
          .post(`/api/v1/institutions/${instOther.id}/history`)
          .set('Origin', staffOne.origin)
          .set('Cookie', staffOne.sessionCookie)
          .set('X-CSRF-Token', staffOne.csrfToken)
          .send({})
          .expect(404);

        await request(app.getHttpServer())
          .get('/api/v1/departments/999999/history')
          .set('Cookie', staffOne.sessionCookie)
          .expect(404);
      } finally {
        await deleteResource(
          `/api/v1/institutions/${instOther.id}`,
          instOther.version,
        );
      }
    });

    it('validates DTO bodies, query parameters, and route IDs strictly', async () => {
      // Invalid route IDs
      for (const badId of ['0', '-1', 'abc', '1.5', '2147483648']) {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/institutions/${badId}`)
          .set('Cookie', staffOne.sessionCookie)
          .expect(400);
        expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      }

      // Stringified expectedVersion in JSON body is rejected (no implicit conversion)
      const stringVersion = await request(app.getHttpServer())
        .patch('/api/v1/institutions/2')
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send({ expectedVersion: '1', name: 'Valid Name' })
        .expect(400);
      expect(stringVersion.body).toMatchObject({ code: 'VALIDATION_ERROR' });

      // Explicit null on PATCH field is rejected
      const nullField = await request(app.getHttpServer())
        .patch('/api/v1/institutions/2')
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send({ expectedVersion: 1, name: null })
        .expect(400);
      expect(nullField.body).toMatchObject({ code: 'VALIDATION_ERROR' });

      // Empty PATCH payload (no mutable fields) is rejected
      const emptyPatch = await request(app.getHttpServer())
        .patch('/api/v1/institutions/2')
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send({ expectedVersion: 1 })
        .expect(400);
      expect(emptyPatch.body).toMatchObject({ code: 'VALIDATION_ERROR' });

      // Missing expectedVersion on DELETE is rejected
      const missingDeleteVersion = await request(app.getHttpServer())
        .delete('/api/v1/institutions/2')
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .expect(400);
      expect((missingDeleteVersion.body as ErrorEnvelope).code).toBe(
        'VALIDATION_ERROR',
      );

      // Control characters and unknown fields are rejected
      await request(app.getHttpServer())
        .post('/api/v1/institutions')
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send({
          name: 'Control\nChar',
          institutionType: 'OTHER',
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/api/v1/institutions')
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send({
          name: 'Extra Field',
          institutionType: 'OTHER',
          unknown: true,
        })
        .expect(400);
    });

    it('publishes all catalog and history routes and DTO schemas in OpenAPI', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/docs-json')
        .expect(200);
      const doc = response.body as OpenApiDocument;

      for (const [path, methods] of [
        ['/api/v1/institutions', ['get', 'post']],
        ['/api/v1/institutions/{id}', ['get', 'patch', 'delete']],
        ['/api/v1/institutions/{id}/history', ['get']],
        ['/api/v1/faculties', ['get', 'post']],
        ['/api/v1/faculties/{id}', ['get', 'patch', 'delete']],
        ['/api/v1/faculties/{id}/history', ['get']],
        ['/api/v1/departments', ['get', 'post']],
        ['/api/v1/departments/{id}', ['get', 'patch', 'delete']],
        ['/api/v1/departments/{id}/history', ['get']],
      ] as const) {
        expect(doc.paths[path]).toBeDefined();
        for (const method of methods) {
          expect(doc.paths[path][method]).toBeDefined();
          expect(doc.paths[path][method].responses?.['409']).toBeDefined();
        }
      }

      for (const schemaName of [
        'EducationalInstitutionDto',
        'FacultyDto',
        'DepartmentDto',
        'ChangeHistoryEntryDto',
        'HistoryStaffActorDto',
      ]) {
        expect(doc.components.schemas[schemaName]).toBeDefined();
      }

      const institutionSchema = doc.components.schemas[
        'EducationalInstitutionDto'
      ] as { properties?: Record<string, unknown> };
      const facultySchema = doc.components.schemas['FacultyDto'] as {
        properties?: Record<string, unknown>;
      };
      expect(institutionSchema.properties).not.toHaveProperty('isFixedOffice');
      expect(facultySchema.properties).not.toHaveProperty('isFixedOffice');
    });
  });

  describe('startup fixed-office verification', () => {
    it('fails startup when the fixed institution or faculty is missing or conflicting', async () => {
      const env = await createTestEnvironment();
      const admin = new Client({ connectionString: env.database.url });
      try {
        await admin.connect();
        await admin.query(
          `UPDATE educational_institution SET name = 'Tampered University' WHERE id = 1`,
        );
        await expect(
          createApplication({ config: loadAppConfig() }),
        ).rejects.toThrow(/fixed/i);

        await admin.query(
          `UPDATE educational_institution SET name = 'Zagazig University' WHERE id = 1`,
        );
        await admin.query(
          `UPDATE faculty SET name = 'Tampered Faculty' WHERE id = 1`,
        );
        await expect(
          createApplication({ config: loadAppConfig() }),
        ).rejects.toThrow(/fixed/i);

        await admin.query(`DELETE FROM faculty WHERE id = 1`);
        await expect(
          createApplication({ config: loadAppConfig() }),
        ).rejects.toThrow(/fixed/i);

        await admin.query(`DELETE FROM educational_institution WHERE id = 1`);
        await expect(
          createApplication({ config: loadAppConfig() }),
        ).rejects.toThrow(/fixed/i);
      } finally {
        await admin.end().catch(() => undefined);
        await env.close();
      }
    });
  });
});
