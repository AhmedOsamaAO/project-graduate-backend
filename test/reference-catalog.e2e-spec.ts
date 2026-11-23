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
  isFixedOffice: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface FacultyPayload {
  id: number;
  institutionId: number;
  name: string;
  isFixedOffice: boolean;
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
      expect((instRes.body as { data: InstitutionPayload }).data).toMatchObject(
        {
          id: 1,
          name: 'Zagazig University',
          institutionType: 'PUBLIC_UNIVERSITY',
          isFixedOffice: true,
          version: 1,
        },
      );

      const facRes = await request(app.getHttpServer())
        .get(`/api/v1/faculties/${FIXED_OFFICE.faculty.id}`)
        .set('Cookie', staffOne.sessionCookie)
        .expect(200);
      expect((facRes.body as { data: FacultyPayload }).data).toMatchObject({
        id: 1,
        institutionId: 1,
        name: 'Faculty of Computer and Information',
        isFixedOffice: true,
        version: 1,
      });

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

    it('supports full CRUD, search, filtering, sorting, conflicts, and history across institutions, faculties, and departments', async () => {
      // Create institutions including special SQL LIKE characters (% and _)
      const instA = (
        (
          await request(app.getHttpServer())
            .post('/api/v1/institutions')
            .set('Origin', staffOne.origin)
            .set('Cookie', staffOne.sessionCookie)
            .set('X-CSRF-Token', staffOne.csrfToken)
            .send({
              name: '  Cairo University  ',
              institutionType: 'PUBLIC_UNIVERSITY',
            })
            .expect(201)
        ).body as { data: InstitutionPayload }
      ).data;
      expect(instA.name).toBe('Cairo University');
      expect(instA.isFixedOffice).toBe(false);
      expect(instA.version).toBe(1);

      const instB = (
        (
          await request(app.getHttpServer())
            .post('/api/v1/institutions')
            .set('Origin', staffOne.origin)
            .set('Cookie', staffOne.sessionCookie)
            .set('X-CSRF-Token', staffOne.csrfToken)
            .send({
              name: 'Institute 100% _Special',
              institutionType: 'PRIVATE_INSTITUTE',
            })
            .expect(201)
        ).body as { data: InstitutionPayload }
      ).data;

      // Literal % and _ search does not match arbitrary records
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

      // Filter by institutionType + deterministic sortBy/sortOrder
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

      // Update institution with version check + stale version conflict
      const updatedInstA = (
        (
          await request(app.getHttpServer())
            .patch(`/api/v1/institutions/${instA.id}`)
            .set('Origin', staffTwo.origin)
            .set('Cookie', staffTwo.sessionCookie)
            .set('X-CSRF-Token', staffTwo.csrfToken)
            .send({ expectedVersion: 1, name: 'Cairo University Updated' })
            .expect(200)
        ).body as { data: InstitutionPayload }
      ).data;
      expect(updatedInstA.version).toBe(2);

      const staleInst = await request(app.getHttpServer())
        .patch(`/api/v1/institutions/${instA.id}`)
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send({ expectedVersion: 1, name: 'Stale Name' })
        .expect(409);
      expect(staleInst.body).toMatchObject({ code: 'STALE_VERSION' });

      // Faculty CRUD + uniqueness within institution + reparenting block on fixed
      const facA = (
        (
          await request(app.getHttpServer())
            .post('/api/v1/faculties')
            .set('Origin', staffOne.origin)
            .set('Cookie', staffOne.sessionCookie)
            .set('X-CSRF-Token', staffOne.csrfToken)
            .send({
              institutionId: instA.id,
              name: 'Faculty of Engineering',
            })
            .expect(201)
        ).body as { data: FacultyPayload }
      ).data;

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

      // Same faculty name under a different institution is allowed
      const facB = (
        (
          await request(app.getHttpServer())
            .post('/api/v1/faculties')
            .set('Origin', staffOne.origin)
            .set('Cookie', staffOne.sessionCookie)
            .set('X-CSRF-Token', staffOne.csrfToken)
            .send({
              institutionId: instB.id,
              name: 'Faculty of Engineering',
            })
            .expect(201)
        ).body as { data: FacultyPayload }
      ).data;

      // List faculties with deterministic sortBy=name and ID tie-breaker
      const listedFac = await request(app.getHttpServer())
        .get('/api/v1/faculties')
        .query({ search: 'Engineering', sortBy: 'name', sortOrder: 'asc' })
        .set('Cookie', staffOne.sessionCookie)
        .expect(200);
      expect(
        (listedFac.body as { items: FacultyPayload[] }).items.map((f) => f.id),
      ).toEqual([facA.id, facB.id]);

      // Department CRUD under fixed faculty and non-fixed faculty
      const deptFixed = (
        (
          await request(app.getHttpServer())
            .post('/api/v1/departments')
            .set('Origin', staffOne.origin)
            .set('Cookie', staffOne.sessionCookie)
            .set('X-CSRF-Token', staffOne.csrfToken)
            .send({
              facultyId: FIXED_OFFICE.faculty.id,
              name: 'Computer Science',
            })
            .expect(201)
        ).body as { data: DepartmentPayload }
      ).data;

      const deptA = (
        (
          await request(app.getHttpServer())
            .post('/api/v1/departments')
            .set('Origin', staffOne.origin)
            .set('Cookie', staffOne.sessionCookie)
            .set('X-CSRF-Token', staffOne.csrfToken)
            .send({
              facultyId: facA.id,
              name: 'Systems Engineering',
            })
            .expect(201)
        ).body as { data: DepartmentPayload }
      ).data;

      const dupDept = await request(app.getHttpServer())
        .post('/api/v1/departments')
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send({
          facultyId: facA.id,
          name: 'Systems Engineering',
        })
        .expect(409);
      expect(dupDept.body).toMatchObject({ code: 'DEPARTMENT_NAME_EXISTS' });

      // Filter departments by institutionId
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

      // Update department
      const updatedDeptA = (
        (
          await request(app.getHttpServer())
            .patch(`/api/v1/departments/${deptA.id}`)
            .set('Origin', staffTwo.origin)
            .set('Cookie', staffTwo.sessionCookie)
            .set('X-CSRF-Token', staffTwo.csrfToken)
            .send({ expectedVersion: 1, name: 'Computer Engineering' })
            .expect(200)
        ).body as { data: DepartmentPayload }
      ).data;
      expect(updatedDeptA.version).toBe(2);

      // Deleting referenced faculty fails with RECORD_IN_USE
      const inUseFac = await request(app.getHttpServer())
        .delete(`/api/v1/faculties/${facA.id}?expectedVersion=${facA.version}`)
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .expect(409);
      expect(inUseFac.body).toMatchObject({ code: 'RECORD_IN_USE' });

      // Delete department, then delete faculty, then delete institution
      await request(app.getHttpServer())
        .delete(
          `/api/v1/departments/${deptA.id}?expectedVersion=${updatedDeptA.version}`,
        )
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .expect(204);

      await request(app.getHttpServer())
        .delete(`/api/v1/faculties/${facA.id}?expectedVersion=${facA.version}`)
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .expect(204);

      await request(app.getHttpServer())
        .delete(
          `/api/v1/institutions/${instA.id}?expectedVersion=${updatedInstA.version}`,
        )
        .set('Origin', staffTwo.origin)
        .set('Cookie', staffTwo.sessionCookie)
        .set('X-CSRF-Token', staffTwo.csrfToken)
        .expect(204);

      // Deleted institution is no longer retrievable via GET
      await request(app.getHttpServer())
        .get(`/api/v1/institutions/${instA.id}`)
        .set('Cookie', staffOne.sessionCookie)
        .expect(404);

      // Paged, newest-first history remains readable by any authenticated staff user including DELETED
      const historyPage1 = await request(app.getHttpServer())
        .get(`/api/v1/institutions/${instA.id}/history`)
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
        recordId: instA.id,
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
        .get(`/api/v1/institutions/${instA.id}/history`)
        .query({ page: 2, pageSize: 2 })
        .set('Cookie', staffTwo.sessionCookie)
        .expect(200);
      const page2Body = historyPage2.body as { items: HistoryPayload[] };
      expect(page2Body.items.map((item) => item.action)).toEqual(['CREATED']);

      // History route is read-only (POST fails as 404; never mutates history)
      await request(app.getHttpServer())
        .post(`/api/v1/institutions/${instB.id}/history`)
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .send({})
        .expect(404);

      // Never-existent record history returns 404
      await request(app.getHttpServer())
        .get('/api/v1/departments/999999/history')
        .set('Cookie', staffOne.sessionCookie)
        .expect(404);

      // Clean up remaining records created in this test
      await request(app.getHttpServer())
        .delete(
          `/api/v1/departments/${deptFixed.id}?expectedVersion=${deptFixed.version}`,
        )
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .expect(204);
      await request(app.getHttpServer())
        .delete(`/api/v1/faculties/${facB.id}?expectedVersion=${facB.version}`)
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .expect(204);
      await request(app.getHttpServer())
        .delete(
          `/api/v1/institutions/${instB.id}?expectedVersion=${instB.version}`,
        )
        .set('Origin', staffOne.origin)
        .set('Cookie', staffOne.sessionCookie)
        .set('X-CSRF-Token', staffOne.csrfToken)
        .expect(204);
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
    });
  });

  describe('startup fixed-office verification', () => {
    it('fails startup when the fixed faculty is missing or conflicting', async () => {
      const env = await createTestEnvironment();
      const admin = new Client({ connectionString: env.database.url });
      try {
        await admin.connect();
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
      } finally {
        await admin.end().catch(() => undefined);
        await env.close();
      }
    });
  });
});
