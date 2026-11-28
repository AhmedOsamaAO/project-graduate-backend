import { ChangeHistoryService } from '../change-history/change-history.service';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  InstitutionType,
  Prisma,
  type HistoryAction,
  type HistoryActorKind,
  type HistoryRecordType,
} from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { FIXED_OFFICE } from './fixed-office';
import { ReferenceDataService } from './reference-data.service';

interface InstitutionRow {
  id: number;
  name: string;
  institutionType: InstitutionType;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface FacultyRow {
  id: number;
  institutionId: number;
  name: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface DepartmentRow {
  id: number;
  facultyId: number;
  name: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface HistoryRow {
  id: number;
  recordType: HistoryRecordType;
  recordId: number | null;
  action: HistoryAction;
  actorKind: HistoryActorKind;
  staffUserId: number | null;
  operatorAttribution: string | null;
  occurredAt: Date;
  before: unknown;
  after: unknown;
}

function adapterError(code: string, nested: 'cause' | 'driverCause' = 'cause') {
  if (nested === 'driverCause') {
    return Object.assign(new Error(`Adapter error ${code}`), {
      meta: { driverAdapterError: { cause: { originalCode: code } } },
    });
  }
  return Object.assign(new Error(`Adapter error ${code}`), {
    cause: { originalCode: code },
  });
}

function createFakeCatalogPrisma() {
  const fixedNow = new Date('2026-11-23T12:00:00.000Z');
  let clockTick = 0;
  const nextTimestamp = () => new Date(fixedNow.getTime() + ++clockTick * 1000);

  let state = {
    institutions: [
      {
        id: FIXED_OFFICE.institution.id,
        name: FIXED_OFFICE.institution.name,
        institutionType: FIXED_OFFICE.institution.institutionType,
        version: 1,
        createdAt: fixedNow,
        updatedAt: fixedNow,
      },
    ] as InstitutionRow[],
    faculties: [
      {
        id: FIXED_OFFICE.faculty.id,
        institutionId: FIXED_OFFICE.faculty.institutionId,
        name: FIXED_OFFICE.faculty.name,
        version: 1,
        createdAt: fixedNow,
        updatedAt: fixedNow,
      },
    ] as FacultyRow[],
    departments: [] as DepartmentRow[],
    history: [] as HistoryRow[],
    nextInstitutionId: 2,
    nextFacultyId: 2,
    nextDepartmentId: 1,
    nextHistoryId: 1,
  };

  let forcedFacultyCreateError: Error | null = null;
  let forcedFacultyUpdateError: Error | null = null;
  let forcedDepartmentCreateError: Error | null = null;
  let forcedDepartmentUpdateError: Error | null = null;
  const qualificationReferences: Array<{
    facultyId: number | null;
    departmentId: number | null;
  }> = [];

  const staffUsers = new Map([
    [10, { id: 10, username: 'staff.one', fullName: 'Staff One' }],
  ]);

  const institutionTypeOrder = Object.values(InstitutionType);

  const sortRows = <T extends Record<string, unknown>>(
    rows: T[],
    orderBy: Array<Record<string, 'asc' | 'desc'>> = [{ id: 'asc' }],
  ) =>
    [...rows].sort((left, right) => {
      for (const clause of orderBy) {
        const [field, direction] = Object.entries(clause)[0];
        const a = left[field];
        const b = right[field];
        let cmp = 0;
        if (field === 'institutionType') {
          cmp =
            institutionTypeOrder.indexOf(a as InstitutionType) -
            institutionTypeOrder.indexOf(b as InstitutionType);
        } else if (a instanceof Date && b instanceof Date) {
          cmp = a.getTime() - b.getTime();
        } else if (typeof a === 'number' && typeof b === 'number') {
          cmp = a - b;
        } else {
          cmp = String(a).localeCompare(String(b));
        }
        if (cmp !== 0) {
          return direction === 'asc' ? cmp : -cmp;
        }
      }
      return 0;
    });

  const filterInstitutions = (where?: {
    name?: { contains?: string };
    institutionType?: InstitutionType;
  }) =>
    state.institutions.filter((row) => {
      if (
        where?.name?.contains &&
        !row.name.toLowerCase().includes(where.name.contains.toLowerCase())
      ) {
        return false;
      }
      if (
        where?.institutionType !== undefined &&
        row.institutionType !== where.institutionType
      ) {
        return false;
      }
      return true;
    });

  const filterFaculties = (where?: {
    name?: { contains?: string };
    institutionId?: number;
  }) =>
    state.faculties.filter((row) => {
      if (
        where?.name?.contains &&
        !row.name.toLowerCase().includes(where.name.contains.toLowerCase())
      ) {
        return false;
      }
      if (
        where?.institutionId !== undefined &&
        row.institutionId !== where.institutionId
      ) {
        return false;
      }
      return true;
    });

  const filterDepartments = (where?: {
    name?: { contains?: string };
    facultyId?: number;
    faculty?: { institutionId?: number };
  }) =>
    state.departments.filter((row) => {
      if (
        where?.name?.contains &&
        !row.name.toLowerCase().includes(where.name.contains.toLowerCase())
      ) {
        return false;
      }
      if (where?.facultyId !== undefined && row.facultyId !== where.facultyId) {
        return false;
      }
      if (where?.faculty?.institutionId !== undefined) {
        const parent = state.faculties.find((f) => f.id === row.facultyId);
        if (!parent || parent.institutionId !== where.faculty.institutionId) {
          return false;
        }
      }
      return true;
    });

  const filterHistory = (where?: {
    recordType?: HistoryRecordType;
    recordId?: number;
  }) =>
    state.history.filter(
      (row) =>
        (where?.recordType === undefined ||
          row.recordType === where.recordType) &&
        (where?.recordId === undefined || row.recordId === where.recordId),
    );

  const client = {
    $queryRaw: () => Promise.resolve([]),
    educationalInstitution: {
      count: ({
        where,
      }: {
        where?: Parameters<typeof filterInstitutions>[0];
      }) => Promise.resolve(filterInstitutions(where).length),
      findMany: ({
        where,
        orderBy,
        skip = 0,
        take = 20,
      }: {
        where?: Parameters<typeof filterInstitutions>[0];
        orderBy?: Array<Record<string, 'asc' | 'desc'>>;
        skip?: number;
        take?: number;
      }) =>
        Promise.resolve(
          sortRows(
            filterInstitutions(where) as unknown as Array<
              Record<string, unknown>
            >,
            orderBy,
          ).slice(skip, skip + take),
        ),
      findUnique: ({ where }: { where: { id: number } }) =>
        Promise.resolve(
          state.institutions.find((row) => row.id === where.id) ?? null,
        ),
      create: ({
        data,
      }: {
        data: { name: string; institutionType: InstitutionType };
      }) => {
        const now = nextTimestamp();
        const created: InstitutionRow = {
          id: state.nextInstitutionId++,
          name: data.name,
          institutionType: data.institutionType,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        state.institutions.push(created);
        return Promise.resolve({ ...created });
      },
      update: ({
        where,
        data,
      }: {
        where: { id: number };
        data: {
          name?: string;
          institutionType?: InstitutionType;
          version: { increment: number };
        };
      }) => {
        const row = state.institutions.find((item) => item.id === where.id)!;
        if (data.name !== undefined) row.name = data.name;
        if (data.institutionType !== undefined) {
          row.institutionType = data.institutionType;
        }
        row.version += data.version.increment;
        row.updatedAt = nextTimestamp();
        return Promise.resolve({ ...row });
      },
      delete: ({ where }: { where: { id: number } }) => {
        if (state.faculties.some((fac) => fac.institutionId === where.id)) {
          return Promise.reject(adapterError('23503'));
        }
        state.institutions = state.institutions.filter(
          (row) => row.id !== where.id,
        );
        return Promise.resolve();
      },
    },
    faculty: {
      count: ({ where }: { where?: Parameters<typeof filterFaculties>[0] }) =>
        Promise.resolve(filterFaculties(where).length),
      findMany: ({
        where,
        orderBy,
        skip = 0,
        take = 20,
      }: {
        where?: Parameters<typeof filterFaculties>[0];
        orderBy?: Array<Record<string, 'asc' | 'desc'>>;
        skip?: number;
        take?: number;
      }) =>
        Promise.resolve(
          sortRows(
            filterFaculties(where) as unknown as Array<Record<string, unknown>>,
            orderBy,
          ).slice(skip, skip + take),
        ),
      findUnique: ({ where }: { where: { id: number } }) =>
        Promise.resolve(
          state.faculties.find((row) => row.id === where.id) ?? null,
        ),
      create: ({ data }: { data: { institutionId: number; name: string } }) => {
        if (forcedFacultyCreateError !== null) {
          const error = forcedFacultyCreateError;
          forcedFacultyCreateError = null;
          return Promise.reject(error);
        }
        if (
          !state.institutions.some((inst) => inst.id === data.institutionId)
        ) {
          return Promise.reject(adapterError('23503', 'driverCause'));
        }
        if (
          state.faculties.some(
            (fac) =>
              fac.institutionId === data.institutionId &&
              fac.name === data.name,
          )
        ) {
          return Promise.reject(adapterError('23505', 'driverCause'));
        }
        const now = nextTimestamp();
        const created: FacultyRow = {
          id: state.nextFacultyId++,
          institutionId: data.institutionId,
          name: data.name,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        state.faculties.push(created);
        return Promise.resolve({ ...created });
      },
      update: ({
        where,
        data,
      }: {
        where: { id: number };
        data: {
          name?: string;
          institutionId?: number;
          version: { increment: number };
        };
      }) => {
        if (forcedFacultyUpdateError !== null) {
          const error = forcedFacultyUpdateError;
          forcedFacultyUpdateError = null;
          return Promise.reject(error);
        }
        const row = state.faculties.find((item) => item.id === where.id)!;
        const nextInstitutionId = data.institutionId ?? row.institutionId;
        const nextName = data.name ?? row.name;
        if (
          nextInstitutionId !== row.institutionId &&
          qualificationReferences.some((ref) => ref.facultyId === row.id)
        ) {
          return Promise.reject(adapterError('23001', 'driverCause'));
        }
        if (!state.institutions.some((inst) => inst.id === nextInstitutionId)) {
          return Promise.reject(adapterError('23503'));
        }
        if (
          state.faculties.some(
            (fac) =>
              fac.id !== row.id &&
              fac.institutionId === nextInstitutionId &&
              fac.name === nextName,
          )
        ) {
          return Promise.reject(adapterError('23505'));
        }
        row.institutionId = nextInstitutionId;
        row.name = nextName;
        row.version += data.version.increment;
        row.updatedAt = nextTimestamp();
        return Promise.resolve({ ...row });
      },
      delete: ({ where }: { where: { id: number } }) => {
        if (state.departments.some((dept) => dept.facultyId === where.id)) {
          return Promise.reject(adapterError('23001', 'driverCause'));
        }
        state.faculties = state.faculties.filter((row) => row.id !== where.id);
        return Promise.resolve();
      },
    },
    department: {
      count: ({ where }: { where?: Parameters<typeof filterDepartments>[0] }) =>
        Promise.resolve(filterDepartments(where).length),
      findMany: ({
        where,
        orderBy,
        skip = 0,
        take = 20,
      }: {
        where?: Parameters<typeof filterDepartments>[0];
        orderBy?: Array<Record<string, 'asc' | 'desc'>>;
        skip?: number;
        take?: number;
      }) =>
        Promise.resolve(
          sortRows(
            filterDepartments(where) as unknown as Array<
              Record<string, unknown>
            >,
            orderBy,
          ).slice(skip, skip + take),
        ),
      findUnique: ({ where }: { where: { id: number } }) =>
        Promise.resolve(
          state.departments.find((row) => row.id === where.id) ?? null,
        ),
      findFirst: ({ where }: { where: { facultyId: number } }) =>
        Promise.resolve(
          state.departments.find((row) => row.facultyId === where.facultyId) ??
            null,
        ),
      create: ({ data }: { data: { facultyId: number; name: string } }) => {
        if (forcedDepartmentCreateError !== null) {
          const error = forcedDepartmentCreateError;
          forcedDepartmentCreateError = null;
          return Promise.reject(error);
        }
        if (!state.faculties.some((fac) => fac.id === data.facultyId)) {
          return Promise.reject(adapterError('23503'));
        }
        if (
          state.departments.some(
            (dept) =>
              dept.facultyId === data.facultyId && dept.name === data.name,
          )
        ) {
          return Promise.reject(adapterError('23505'));
        }
        const now = nextTimestamp();
        const created: DepartmentRow = {
          id: state.nextDepartmentId++,
          facultyId: data.facultyId,
          name: data.name,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        state.departments.push(created);
        return Promise.resolve({ ...created });
      },
      update: ({
        where,
        data,
      }: {
        where: { id: number };
        data: {
          name?: string;
          facultyId?: number;
          version: { increment: number };
        };
      }) => {
        if (forcedDepartmentUpdateError !== null) {
          const error = forcedDepartmentUpdateError;
          forcedDepartmentUpdateError = null;
          return Promise.reject(error);
        }
        const row = state.departments.find((item) => item.id === where.id)!;
        const nextFacultyId = data.facultyId ?? row.facultyId;
        const nextName = data.name ?? row.name;
        if (
          nextFacultyId !== row.facultyId &&
          qualificationReferences.some((ref) => ref.departmentId === row.id)
        ) {
          return Promise.reject(adapterError('23001', 'driverCause'));
        }
        if (!state.faculties.some((fac) => fac.id === nextFacultyId)) {
          return Promise.reject(adapterError('23503'));
        }
        if (
          state.departments.some(
            (dept) =>
              dept.id !== row.id &&
              dept.facultyId === nextFacultyId &&
              dept.name === nextName,
          )
        ) {
          return Promise.reject(adapterError('23505'));
        }
        row.facultyId = nextFacultyId;
        row.name = nextName;
        row.version += data.version.increment;
        row.updatedAt = nextTimestamp();
        return Promise.resolve({ ...row });
      },
      delete: ({ where }: { where: { id: number } }) => {
        state.departments = state.departments.filter(
          (row) => row.id !== where.id,
        );
        return Promise.resolve();
      },
    },
    changeHistory: {
      count: ({
        where,
      }: {
        where?: { recordType?: HistoryRecordType; recordId?: number };
      }) => Promise.resolve(filterHistory(where).length),
      findMany: ({
        where,
        skip = 0,
        take = 20,
      }: {
        where?: { recordType?: HistoryRecordType; recordId?: number };
        skip?: number;
        take?: number;
      }) => {
        const sorted = [...filterHistory(where)].sort((left, right) => {
          const timeDiff =
            right.occurredAt.getTime() - left.occurredAt.getTime();
          return timeDiff !== 0 ? timeDiff : right.id - left.id;
        });
        return Promise.resolve(
          sorted.slice(skip, skip + take).map((row) => ({
            ...row,
            staffUser:
              row.staffUserId !== null
                ? (staffUsers.get(row.staffUserId) ?? null)
                : null,
          })),
        );
      },
      create: ({
        data,
      }: {
        data: {
          recordType: HistoryRecordType;
          recordId: number;
          action: HistoryAction;
          actorKind: HistoryActorKind;
          staffUserId: number;
          before: unknown;
          after: unknown;
        };
      }) => {
        const created: HistoryRow = {
          id: state.nextHistoryId++,
          recordType: data.recordType,
          recordId: data.recordId,
          action: data.action,
          actorKind: data.actorKind,
          staffUserId: data.staffUserId,
          operatorAttribution: null,
          occurredAt: nextTimestamp(),
          before: data.before === Prisma.DbNull ? null : data.before,
          after: data.after === Prisma.DbNull ? null : data.after,
        };
        state.history.push(created);
        return Promise.resolve({ id: created.id });
      },
    },
    $transaction: async (arg: unknown) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      const snapshot = structuredClone(state);
      try {
        return await (arg as (tx: typeof client) => Promise<unknown>)(client);
      } catch (error) {
        state = snapshot;
        throw error;
      }
    },
  };

  return {
    prisma: client as unknown as PrismaService,
    setForcedFacultyCreateError: (error: Error) => {
      forcedFacultyCreateError = error;
    },
    setForcedFacultyUpdateError: (error: Error) => {
      forcedFacultyUpdateError = error;
    },
    setForcedDepartmentCreateError: (error: Error) => {
      forcedDepartmentCreateError = error;
    },
    setForcedDepartmentUpdateError: (error: Error) => {
      forcedDepartmentUpdateError = error;
    },
    addQualificationReference: (ref: {
      facultyId: number | null;
      departmentId: number | null;
    }) => {
      qualificationReferences.push(ref);
    },
  };
}

describe('ReferenceDataService', () => {
  const actor = { staffUserId: 10 };

  function makeService() {
    const fake = createFakeCatalogPrisma();
    return {
      service: new ReferenceDataService(
        fake.prisma,
        new ChangeHistoryService(fake.prisma),
      ),
      ...fake,
    };
  }

  it('rejects invalid names, empty updates, and invalid IDs with VALIDATION_ERROR', async () => {
    const { service } = makeService();

    await expect(
      service.createInstitution(actor, {
        name: '   ',
        institutionType: 'PUBLIC_UNIVERSITY',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    await expect(
      service.createInstitution(actor, {
        name: 'Bad\nName',
        institutionType: 'PUBLIC_UNIVERSITY',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    await expect(
      service.updateInstitution(actor, 2, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    await expect(
      service.updateFaculty(actor, 2, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    await expect(
      service.updateDepartment(actor, 2, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    await expect(service.deleteInstitution(actor, 0, 1)).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
    });

    const page = await service.listInstitutions();
    expect(page.total).toBe(1);
  });

  it('protects fixed institution and fixed faculty from update, reparenting, and deletion without recording history', async () => {
    const { service } = makeService();

    await expect(
      service.updateInstitution(actor, 1, {
        expectedVersion: 1,
        name: 'Renamed',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FIXED_RECORD_PROTECTED });

    await expect(service.deleteInstitution(actor, 1, 1)).rejects.toMatchObject({
      code: ERROR_CODES.FIXED_RECORD_PROTECTED,
    });

    await expect(
      service.updateFaculty(actor, 1, {
        expectedVersion: 1,
        institutionId: 2,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FIXED_RECORD_PROTECTED });

    await expect(service.deleteFaculty(actor, 1, 1)).rejects.toMatchObject({
      code: ERROR_CODES.FIXED_RECORD_PROTECTED,
    });

    expect(await service.getInstitution(1)).toMatchObject({
      name: 'Zagazig University',
      version: 1,
    });
    expect(await service.getFaculty(1)).toMatchObject({
      name: 'Faculty of Computer and Information',
      institutionId: 1,
      version: 1,
    });
    expect((await service.getInstitutionHistory(1)).total).toBe(0);
    expect((await service.getFacultyHistory(1)).total).toBe(0);
  });

  it('allows reparenting an unreferenced faculty, blocks reparenting when referenced by departments, and permits name updates', async () => {
    const { service } = makeService();
    const instA = await service.createInstitution(actor, {
      name: 'Institution A',
      institutionType: 'PUBLIC_UNIVERSITY',
    });
    const instB = await service.createInstitution(actor, {
      name: 'Institution B',
      institutionType: 'PRIVATE_UNIVERSITY',
    });
    const fac = await service.createFaculty(actor, {
      institutionId: instA.id,
      name: 'Faculty of Science',
    });

    const reparented = await service.updateFaculty(actor, fac.id, {
      expectedVersion: fac.version,
      institutionId: instB.id,
    });
    expect(reparented).toMatchObject({
      id: fac.id,
      institutionId: instB.id,
      version: 2,
    });

    await service.createDepartment(actor, {
      facultyId: fac.id,
      name: 'Physics',
    });

    await expect(
      service.updateFaculty(actor, fac.id, {
        expectedVersion: reparented.version,
        institutionId: instA.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

    expect(await service.getFaculty(fac.id)).toMatchObject({
      institutionId: instB.id,
      version: 2,
    });
    expect((await service.getFacultyHistory(fac.id)).total).toBe(2);

    const renamedOnly = await service.updateFaculty(actor, fac.id, {
      expectedVersion: reparented.version,
      name: 'Faculty of Applied Science',
    });
    expect(renamedOnly).toMatchObject({
      name: 'Faculty of Applied Science',
      institutionId: instB.id,
      version: 3,
    });

    const renamedSameParent = await service.updateFaculty(actor, fac.id, {
      expectedVersion: renamedOnly.version,
      institutionId: instB.id,
      name: 'Faculty of Pure Science',
    });
    expect(renamedSameParent).toMatchObject({
      name: 'Faculty of Pure Science',
      institutionId: instB.id,
      version: 4,
    });
  });

  it('lists catalog records with trimmed search, filters, and deterministic sorting with id tie-breaker', async () => {
    const { service } = makeService();
    const instB = await service.createInstitution(actor, {
      name: 'Cairo Private Institute',
      institutionType: 'PRIVATE_INSTITUTE',
    });
    const instA = await service.createInstitution(actor, {
      name: 'Cairo Public University',
      institutionType: 'PUBLIC_UNIVERSITY',
    });

    const sortedInsts = await service.listInstitutions({
      search: '  Cairo  ',
      sortBy: 'institutionType',
      sortOrder: 'desc',
    });
    expect(sortedInsts.items.map((item) => item.id)).toEqual([
      instB.id,
      instA.id,
    ]);

    const fac1 = await service.createFaculty(actor, {
      institutionId: instA.id,
      name: 'Engineering',
    });
    const fac2 = await service.createFaculty(actor, {
      institutionId: instB.id,
      name: 'Engineering',
    });
    const tiedFacs = await service.listFaculties({
      search: 'Engineering',
      sortBy: 'name',
      sortOrder: 'asc',
    });
    expect(tiedFacs.items.map((item) => item.id)).toEqual([fac1.id, fac2.id]);

    const dept1 = await service.createDepartment(actor, {
      facultyId: fac1.id,
      name: 'Alpha Dept',
    });
    const dept2 = await service.createDepartment(actor, {
      facultyId: fac1.id,
      name: 'Beta Dept',
    });
    await service.createDepartment(actor, {
      facultyId: fac2.id,
      name: 'Gamma Dept',
    });

    const filteredDepts = await service.listDepartments({
      institutionId: instA.id,
      facultyId: fac1.id,
      sortBy: 'id',
      sortOrder: 'desc',
    });
    expect(filteredDepts.items.map((item) => item.id)).toEqual([
      dept2.id,
      dept1.id,
    ]);
  });

  it('maps database unique and foreign-key errors to domain conflicts and not-found errors', async () => {
    const {
      service,
      setForcedFacultyCreateError,
      setForcedDepartmentCreateError,
    } = makeService();
    const inst = await service.createInstitution(actor, {
      name: 'Cairo University',
      institutionType: 'PUBLIC_UNIVERSITY',
    });
    const fac = await service.createFaculty(actor, {
      institutionId: inst.id,
      name: 'Engineering',
    });
    await service.createDepartment(actor, {
      facultyId: fac.id,
      name: 'Systems',
    });

    await expect(
      service.createFaculty(actor, {
        institutionId: inst.id,
        name: 'Engineering',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FACULTY_NAME_EXISTS });

    await expect(
      service.createDepartment(actor, {
        facultyId: fac.id,
        name: 'Systems',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.DEPARTMENT_NAME_EXISTS });

    await expect(
      service.deleteInstitution(actor, inst.id, inst.version),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

    await expect(
      service.deleteFaculty(actor, fac.id, fac.version),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

    setForcedFacultyCreateError(
      Object.assign(new Error('Foreign key error'), {
        meta: { driverAdapterError: { cause: { originalCode: '23503' } } },
      }),
    );
    await expect(
      service.createFaculty(actor, {
        institutionId: inst.id,
        name: 'Medicine',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    setForcedDepartmentCreateError(
      Object.assign(new Error('Foreign key error'), {
        cause: { code: '23503' },
      }),
    );
    await expect(
      service.createDepartment(actor, {
        facultyId: fac.id,
        name: 'Biomedical',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });

  it('blocks reparenting a faculty or department referenced by student qualifications and maps 23001 restrict errors to RECORD_IN_USE', async () => {
    const {
      service,
      addQualificationReference,
      setForcedFacultyUpdateError,
      setForcedDepartmentUpdateError,
    } = makeService();
    const instA = await service.createInstitution(actor, {
      name: 'Source Univ',
      institutionType: 'PUBLIC_UNIVERSITY',
    });
    const instB = await service.createInstitution(actor, {
      name: 'Target Univ',
      institutionType: 'PRIVATE_UNIVERSITY',
    });
    const facA = await service.createFaculty(actor, {
      institutionId: instA.id,
      name: 'Faculty A',
    });
    const facB = await service.createFaculty(actor, {
      institutionId: instA.id,
      name: 'Faculty B',
    });
    const facUnref = await service.createFaculty(actor, {
      institutionId: instA.id,
      name: 'Unreferenced Faculty',
    });
    const dept = await service.createDepartment(actor, {
      facultyId: facB.id,
      name: 'Department B',
    });

    // Qualification referencing facA (with no departments) blocks reparenting facA
    addQualificationReference({ facultyId: facA.id, departmentId: null });
    await expect(
      service.updateFaculty(actor, facA.id, {
        expectedVersion: facA.version,
        institutionId: instB.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

    // Qualification referencing dept blocks reparenting dept to facA
    addQualificationReference({ facultyId: facB.id, departmentId: dept.id });
    await expect(
      service.updateDepartment(actor, dept.id, {
        expectedVersion: dept.version,
        facultyId: facA.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

    // Renaming a qualification-referenced faculty or department remains allowed
    const renamedFac = await service.updateFaculty(actor, facA.id, {
      expectedVersion: facA.version,
      name: 'Faculty A Renamed',
    });
    expect(renamedFac.name).toBe('Faculty A Renamed');

    const renamedDept = await service.updateDepartment(actor, dept.id, {
      expectedVersion: dept.version,
      name: 'Department B Renamed',
    });
    expect(renamedDept.name).toBe('Department B Renamed');

    // Race hitting PostgreSQL ON UPDATE RESTRICT (23001) maps to RECORD_IN_USE
    setForcedFacultyUpdateError(adapterError('23001', 'driverCause'));
    await expect(
      service.updateFaculty(actor, facUnref.id, {
        expectedVersion: facUnref.version,
        institutionId: instB.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

    const deptUnref = await service.createDepartment(actor, {
      facultyId: facUnref.id,
      name: 'Unref Dept',
    });
    setForcedDepartmentUpdateError(adapterError('23001'));
    await expect(
      service.updateDepartment(actor, deptUnref.id, {
        expectedVersion: deptUnref.version,
        facultyId: facA.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });
  });
});
