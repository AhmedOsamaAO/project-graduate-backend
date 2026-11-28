import { ChangeHistoryService } from '../change-history/change-history.service';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  DocumentAvailability,
  DocumentType,
  MilitaryStatus,
  Prisma,
  type Document,
  type HistoryAction,
  type HistoryActorKind,
  type HistoryRecordType,
  type Student,
} from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { StudentArchiveGuardRegistry } from './student-archive-guard';
import { StudentsService } from './students.service';

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

function createFakeStudentsPrisma() {
  const baseNow = new Date('2026-11-25T10:00:00.000Z');
  let tick = 0;
  const nextTimestamp = () => new Date(baseNow.getTime() + ++tick * 1000);

  let state = {
    students: [] as Student[],
    documents: [] as Document[],
    history: [] as HistoryRow[],
    nextStudentId: 1,
    nextDocumentId: 1,
    nextHistoryId: 1,
  };

  let forcedStudentMutationError: Error | null = null;
  let queuedRetryErrors: Error[] = [];

  const staffUsers = new Map([
    [10, { id: 10, username: 'staff.one', fullName: 'Staff One' }],
  ]);

  const sortStudents = (
    rows: Student[],
    orderBy: Array<Record<string, 'asc' | 'desc'>> = [{ id: 'asc' }],
  ) =>
    [...rows].sort((left, right) => {
      for (const clause of orderBy) {
        const [field, direction] = Object.entries(clause)[0];
        const a = left[field as keyof Student];
        const b = right[field as keyof Student];
        let cmp = 0;
        if (typeof a === 'number' && typeof b === 'number') {
          cmp = a - b;
        } else if (a instanceof Date && b instanceof Date) {
          cmp = a.getTime() - b.getTime();
        } else {
          cmp = String(a ?? '').localeCompare(String(b ?? ''));
        }
        if (cmp !== 0) {
          return direction === 'asc' ? cmp : -cmp;
        }
      }
      return 0;
    });

  const matchesClause = (
    row: Student,
    clause: Record<string, unknown>,
  ): boolean => {
    if ('AND' in clause && Array.isArray(clause.AND)) {
      return clause.AND.every((sub) =>
        matchesClause(row, sub as Record<string, unknown>),
      );
    }
    if ('OR' in clause && Array.isArray(clause.OR)) {
      return clause.OR.some((sub) =>
        matchesClause(row, sub as Record<string, unknown>),
      );
    }
    if ('archivedAt' in clause) {
      const filter = clause.archivedAt;
      if (filter === null && row.archivedAt !== null) {
        return false;
      }
      if (
        typeof filter === 'object' &&
        filter !== null &&
        'not' in filter &&
        filter.not === null &&
        row.archivedAt === null
      ) {
        return false;
      }
    }
    if ('fullName' in clause) {
      const filter = clause.fullName as { contains?: string };
      if (
        filter.contains &&
        !row.fullName.toLowerCase().includes(filter.contains.toLowerCase())
      ) {
        return false;
      }
    }
    if ('nationalId' in clause) {
      const filter = clause.nationalId as {
        startsWith?: string;
        contains?: string;
      };
      if (filter.startsWith && !row.nationalId.startsWith(filter.startsWith)) {
        return false;
      }
      if (filter.contains && !row.nationalId.includes(filter.contains)) {
        return false;
      }
    }
    if (
      'militaryStatus' in clause &&
      row.militaryStatus !== clause.militaryStatus
    ) {
      return false;
    }
    return true;
  };

  const makeClient = (getWorking: () => typeof state) => ({
    $queryRaw: () => Promise.resolve([]),
    student: {
      count: ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
        Promise.resolve(
          getWorking().students.filter((row) => matchesClause(row, where))
            .length,
        ),
      findMany: ({
        where = {},
        orderBy,
        skip = 0,
        take,
      }: {
        where?: Record<string, unknown>;
        orderBy?: Array<Record<string, 'asc' | 'desc'>>;
        skip?: number;
        take?: number;
      } = {}) => {
        const filtered = getWorking().students.filter((row) =>
          matchesClause(row, where),
        );
        const sorted = sortStudents(filtered, orderBy);
        const end = take === undefined ? undefined : skip + take;
        return Promise.resolve(
          sorted.slice(skip, end).map((row) => structuredClone(row)),
        );
      },
      findUnique: ({
        where,
      }: {
        where: { id?: number; nationalId?: string };
      }) => {
        const found = getWorking().students.find((row) =>
          where.id !== undefined
            ? row.id === where.id
            : row.nationalId === where.nationalId,
        );
        return Promise.resolve(found ? structuredClone(found) : null);
      },
      create: ({
        data,
      }: {
        data: {
          fullName: string;
          nationalId: string;
          phone: string | null;
          birthDate: Date | null;
          address: string | null;
          militaryStatus: MilitaryStatus | null;
          selectedPhotoDocumentId: number | null;
          archivedAt: Date | null;
        };
      }) => {
        const working = getWorking();
        if (forcedStudentMutationError) {
          const err = forcedStudentMutationError;
          forcedStudentMutationError = null;
          return Promise.reject(err);
        }
        if (
          working.students.some((row) => row.nationalId === data.nationalId)
        ) {
          return Promise.reject(adapterError('23505'));
        }
        const now = nextTimestamp();
        const created: Student = {
          id: working.nextStudentId++,
          fullName: data.fullName,
          nationalId: data.nationalId,
          phone: data.phone,
          birthDate: data.birthDate,
          address: data.address,
          militaryStatus: data.militaryStatus,
          selectedPhotoDocumentId: data.selectedPhotoDocumentId,
          archivedAt: data.archivedAt,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        working.students.push(created);
        return Promise.resolve(structuredClone(created));
      },
      update: ({
        where,
        data,
      }: {
        where: { id: number };
        data: {
          fullName?: string;
          nationalId?: string;
          phone?: string | null;
          birthDate?: Date | null;
          address?: string | null;
          militaryStatus?: MilitaryStatus | null;
          selectedPhotoDocumentId?: number | null;
          archivedAt?: Date | null;
          version?: { increment: number };
        };
      }) => {
        const working = getWorking();
        const index = working.students.findIndex((row) => row.id === where.id);
        if (index === -1) {
          return Promise.reject(new Error('Student row missing'));
        }
        const current = working.students[index];
        if (
          data.nationalId !== undefined &&
          working.students.some(
            (row) => row.id !== where.id && row.nationalId === data.nationalId,
          )
        ) {
          return Promise.reject(adapterError('23505'));
        }
        const updated: Student = {
          ...current,
          fullName: data.fullName ?? current.fullName,
          nationalId: data.nationalId ?? current.nationalId,
          phone: data.phone !== undefined ? data.phone : current.phone,
          birthDate:
            data.birthDate !== undefined ? data.birthDate : current.birthDate,
          address: data.address !== undefined ? data.address : current.address,
          militaryStatus:
            data.militaryStatus !== undefined
              ? data.militaryStatus
              : current.militaryStatus,
          selectedPhotoDocumentId:
            data.selectedPhotoDocumentId !== undefined
              ? data.selectedPhotoDocumentId
              : current.selectedPhotoDocumentId,
          archivedAt:
            data.archivedAt !== undefined
              ? data.archivedAt
              : current.archivedAt,
          version: current.version + (data.version?.increment ?? 0),
          updatedAt: nextTimestamp(),
        };
        working.students[index] = updated;
        return Promise.resolve(structuredClone(updated));
      },
    },
    document: {
      findUnique: ({ where }: { where: { id: number } }) => {
        const found = getWorking().documents.find((row) => row.id === where.id);
        return Promise.resolve(found ? structuredClone(found) : null);
      },
    },
    changeHistory: {
      create: ({
        data,
      }: {
        data: {
          recordType: HistoryRecordType;
          recordId: number | null;
          action: HistoryAction;
          actorKind: HistoryActorKind;
          staffUserId?: number;
          operatorAttribution?: string;
          before: unknown;
          after: unknown;
        };
      }) => {
        const working = getWorking();
        const row: HistoryRow = {
          id: working.nextHistoryId++,
          recordType: data.recordType,
          recordId: data.recordId,
          action: data.action,
          actorKind: data.actorKind,
          staffUserId: data.staffUserId ?? null,
          operatorAttribution: data.operatorAttribution ?? null,
          occurredAt: nextTimestamp(),
          before:
            data.before === Prisma.DbNull ? null : structuredClone(data.before),
          after:
            data.after === Prisma.DbNull ? null : structuredClone(data.after),
        };
        working.history.push(row);
        return Promise.resolve(structuredClone(row));
      },
      count: ({
        where,
      }: {
        where: { recordType: HistoryRecordType; recordId: number };
      }) =>
        Promise.resolve(
          getWorking().history.filter(
            (row) =>
              row.recordType === where.recordType &&
              row.recordId === where.recordId,
          ).length,
        ),
      findMany: ({
        where,
        skip = 0,
        take = 20,
      }: {
        where: { recordType: HistoryRecordType; recordId: number };
        skip?: number;
        take?: number;
      }) =>
        Promise.resolve(
          getWorking()
            .history.filter(
              (row) =>
                row.recordType === where.recordType &&
                row.recordId === where.recordId,
            )
            .sort(
              (a, b) =>
                b.occurredAt.getTime() - a.occurredAt.getTime() || b.id - a.id,
            )
            .slice(skip, skip + take)
            .map((row) => ({
              ...structuredClone(row),
              staffUser: row.staffUserId
                ? (staffUsers.get(row.staffUserId) ?? null)
                : null,
            })),
        ),
    },
  });

  const root = makeClient(() => state);

  const prisma = {
    ...root,
    $transaction: async <T>(
      arg:
        | Array<Promise<unknown>>
        | ((tx: Prisma.TransactionClient) => Promise<T>),
    ) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }

      if (queuedRetryErrors.length > 0) {
        const err = queuedRetryErrors.shift()!;
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
    getStudents: () => state.students,
    getHistory: () => state.history,
    addDocument: (
      overrides: Partial<Document> & {
        studentId: number;
        documentType: DocumentType;
      },
    ): Document => {
      const now = nextTimestamp();
      const doc: Document = {
        id: state.nextDocumentId++,
        studentId: overrides.studentId,
        supervisorId: overrides.supervisorId ?? null,
        qualificationId: overrides.qualificationId ?? null,
        documentType: overrides.documentType,
        description: overrides.description ?? null,
        originalFileName: overrides.originalFileName ?? 'photo.jpg',
        storageKey: overrides.storageKey ?? 'a'.repeat(64),
        mimeType: overrides.mimeType ?? 'image/jpeg',
        byteSize: overrides.byteSize ?? 1024,
        uploadedAt: overrides.uploadedAt ?? now,
        archivedAt: overrides.archivedAt ?? null,
        availability: overrides.availability ?? DocumentAvailability.AVAILABLE,
        deletedAt: overrides.deletedAt ?? null,
        deletedByStaffUserId: overrides.deletedByStaffUserId ?? null,
        version: overrides.version ?? 1,
        createdAt: overrides.createdAt ?? now,
        updatedAt: overrides.updatedAt ?? now,
      };
      state.documents.push(doc);
      return doc;
    },
    forceNextCreateError: (error: Error) => {
      forcedStudentMutationError = error;
    },
    queueRetryErrors: (...errors: Error[]) => {
      queuedRetryErrors = [...errors];
    },
  };
}

describe('StudentsService', () => {
  const actor = { staffUserId: 10 };
  const fixedClock = { now: () => new Date('2026-01-15T22:00:00.000Z') }; // 2026-01-16 in Cairo

  let fakeDb: ReturnType<typeof createFakeStudentsPrisma>;
  let archiveGuards: StudentArchiveGuardRegistry;
  let service: StudentsService;

  beforeEach(() => {
    fakeDb = createFakeStudentsPrisma();
    archiveGuards = new StudentArchiveGuardRegistry();
    const historyService = new ChangeHistoryService(fakeDb.prisma);
    service = new StudentsService(
      fakeDb.prisma,
      historyService,
      archiveGuards,
      fixedClock,
    );
  });

  it('creates a student with only trimmed fullName and normalized 14-digit nationalId, writing history atomically', async () => {
    const created = await service.createStudent(actor, {
      fullName: '  أحمد  ',
      nationalId: '  ٠٠١٢٣٤٥٦٧٨٩٠١٢  ',
    });

    expect(created).toMatchObject({
      id: 1,
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

    const history = await service.getStudentHistory(created.id);
    expect(history.total).toBe(1);
    expect(history.items[0]).toMatchObject({
      recordType: 'STUDENT',
      recordId: 1,
      action: 'CREATED',
      actorKind: 'STAFF',
      staffUser: { id: 10 },
      before: null,
      after: created,
    });
  });

  it('rejects birthDate in the future using the Africa/Cairo office calendar without mutating the database', async () => {
    await expect(
      service.createStudent(actor, {
        fullName: 'Nora Ali',
        nationalId: '29901011234567',
        birthDate: '2026-01-17',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    expect(fakeDb.getStudents()).toHaveLength(0);
    expect(fakeDb.getHistory()).toHaveLength(0);

    const todayValid = await service.createStudent(actor, {
      fullName: 'Nora Ali',
      nationalId: '29901011234567',
      birthDate: '2026-01-16',
      militaryStatus: MilitaryStatus.COMPLETED,
    });
    expect(todayValid.birthDate).toBe('2026-01-16');
  });

  it('updates student fields including correcting mistyped nationalId and clearing nullable fields with expectedVersion', async () => {
    const created = await service.createStudent(actor, {
      fullName: 'Sara Hassan',
      nationalId: '29901011234567',
      phone: '01001234567',
      birthDate: '1999-01-01',
      address: 'Zagazig',
      militaryStatus: MilitaryStatus.EXEMPTED,
    });

    const updated = await service.updateStudent(actor, created.id, {
      expectedVersion: created.version,
      fullName: '  Sara Mohamed Hassan  ',
      nationalId: '٠٠٩٨٧٦٥٤٣٢١٠٩٨',
      phone: null,
      birthDate: null,
    });

    expect(updated).toMatchObject({
      id: created.id,
      fullName: 'Sara Mohamed Hassan',
      nationalId: '00987654321098',
      phone: null,
      birthDate: null,
      address: 'Zagazig',
      militaryStatus: 'EXEMPTED',
      version: 2,
    });

    await expect(
      service.updateStudent(actor, created.id, {
        expectedVersion: 1,
        fullName: 'Stale Edit',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STALE_VERSION });
  });

  it('retries serialization conflicts up to 3 attempts preserving original expectedVersion', async () => {
    const created = await service.createStudent(actor, {
      fullName: 'Omar Adel',
      nationalId: '29805051234567',
    });

    fakeDb.queueRetryErrors(
      adapterError('40001'),
      adapterError('P2034', 'driverCause'),
    );
    const updated = await service.updateStudent(actor, created.id, {
      expectedVersion: 1,
      phone: '01099999999',
    });
    expect(updated.version).toBe(2);

    fakeDb.queueRetryErrors(
      adapterError('40001'),
      adapterError('40001'),
      adapterError('40001'),
    );
    await expect(
      service.updateStudent(actor, created.id, {
        expectedVersion: 2,
        phone: '01088888888',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.RETRYABLE_CONFLICT });
  });

  it('searches by name and nationalId with leading zeros and filters archived students by visibility', async () => {
    const active = await service.createStudent(actor, {
      fullName: 'أحمد سامي',
      nationalId: '00112233445566',
      militaryStatus: MilitaryStatus.POSTPONED,
    });
    const toArchive = await service.createStudent(actor, {
      fullName: 'Mona Adel',
      nationalId: '00998877665544',
    });
    await service.archiveStudent(actor, toArchive.id, toArchive.version);

    // Ordinary search excludes archived students
    const defaultList = await service.listStudents({ search: '٠٠' });
    expect(defaultList.items.map((s) => s.id)).toEqual([active.id]);

    // Explicit archive query finds archived student
    const archivedList = await service.listStudents({
      archiveStatus: 'ARCHIVED',
      nationalId: '٠٠٩٩',
    });
    expect(archivedList.items.map((s) => s.id)).toEqual([toArchive.id]);

    // Ordinary get & history hide archived student
    await expect(service.getStudent(toArchive.id)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    });
    await expect(service.getStudentHistory(toArchive.id)).rejects.toMatchObject(
      {
        code: ERROR_CODES.NOT_FOUND,
      },
    );

    // Explicit authenticated view succeeds
    await expect(
      service.getStudent(toArchive.id, { includeArchived: true }),
    ).resolves.toMatchObject({
      id: toArchive.id,
      nationalId: '00998877665544',
    });
    await expect(
      service.getStudentHistory(toArchive.id, { includeArchived: true }),
    ).resolves.toMatchObject({ total: 2 });
  });

  it('identifies archived students on duplicate national ID and retains identity and history on restore', async () => {
    const created = await service.createStudent(actor, {
      fullName: 'Karim Tarek',
      nationalId: '00554433221100',
    });
    const archived = await service.archiveStudent(
      actor,
      created.id,
      created.version,
    );

    // Direct create finds archived conflict
    try {
      await service.createStudent(actor, {
        fullName: 'Duplicate Attempt',
        nationalId: '٠٠٥٥٤٤٣٣٢٢١١٠٠',
      });
      fail('Expected archived conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiErr = error as ApiError;
      expect(apiErr.code).toBe(ERROR_CODES.STUDENT_NATIONAL_ID_ARCHIVED);
      expect(apiErr.getResponse()).toMatchObject({
        code: ERROR_CODES.STUDENT_NATIONAL_ID_ARCHIVED,
        details: {
          studentId: created.id,
          fullName: 'Karim Tarek',
          nationalId: '00554433221100',
          archivedAt: archived.archivedAt,
          version: archived.version,
          requiresRestore: true,
        },
      });
    }

    // Even if a race triggers DB unique violation (23505) on create, mapNationalIdUniqueConflict maps it to STUDENT_NATIONAL_ID_ARCHIVED
    fakeDb.forceNextCreateError(adapterError('23505'));
    await expect(
      service.createStudent(actor, {
        fullName: 'Race Attempt',
        nationalId: '00554433221100',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.STUDENT_NATIONAL_ID_ARCHIVED,
    });

    // Updating archived student is blocked until restored
    await expect(
      service.updateStudent(actor, archived.id, {
        expectedVersion: archived.version,
        phone: '01011111111',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STUDENT_ARCHIVED });

    const restored = await service.restoreStudent(
      actor,
      archived.id,
      archived.version,
    );
    expect(restored).toMatchObject({
      id: created.id,
      archivedAt: null,
      version: 3,
    });

    const history = await service.getStudentHistory(restored.id);
    expect(history.items.map((item) => item.action)).toEqual([
      'RESTORED',
      'ARCHIVED',
      'CREATED',
    ]);
  });

  it('invokes registered student archive guards inside the archive transaction', async () => {
    const created = await service.createStudent(actor, {
      fullName: 'Youssef Nabil',
      nationalId: '30101011234567',
    });

    const unregister = archiveGuards.register({
      name: 'pending-document-deletion',
      assertCanArchive() {
        return Promise.reject(
          new ApiError(409, ERROR_CODES.CONFLICT, 'Pending file deletion'),
        );
      },
    });

    await expect(
      service.archiveStudent(actor, created.id, created.version),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });

    // Student remains active with unchanged version and history
    await expect(service.getStudent(created.id)).resolves.toMatchObject({
      id: created.id,
      archivedAt: null,
      version: 1,
    });

    unregister();
    await expect(
      service.archiveStudent(actor, created.id, created.version),
    ).resolves.toMatchObject({
      id: created.id,
      version: 2,
    });
  });

  it('rejects double-archive, restoring active student, and empty update payloads', async () => {
    const created = await service.createStudent(actor, {
      fullName: 'Layla Amr',
      nationalId: '30202021234567',
    });

    await expect(
      service.updateStudent(actor, created.id, {
        expectedVersion: created.version,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    await expect(
      service.restoreStudent(actor, created.id, created.version),
    ).rejects.toMatchObject({ code: ERROR_CODES.STUDENT_NOT_ARCHIVED });

    const archived = await service.archiveStudent(
      actor,
      created.id,
      created.version,
    );

    await expect(
      service.archiveStudent(actor, archived.id, archived.version),
    ).rejects.toMatchObject({ code: ERROR_CODES.STUDENT_ALREADY_ARCHIVED });
  });

  it('selects, changes, and clears a student personal photo while enforcing ownership, category, availability, archive, and version rules', async () => {
    const student = await service.createStudent(actor, {
      fullName: 'Sara Hassan',
      nationalId: '30303031234567',
    });
    const other = await service.createStudent(actor, {
      fullName: 'Other Student',
      nationalId: '30404041234567',
    });

    const photo1 = fakeDb.addDocument({
      studentId: student.id,
      documentType: DocumentType.PERSONAL_PHOTO,
      storageKey: '1'.repeat(64),
    });
    const photo2 = fakeDb.addDocument({
      studentId: student.id,
      documentType: DocumentType.PERSONAL_PHOTO,
      storageKey: '2'.repeat(64),
    });
    const nonPhoto = fakeDb.addDocument({
      studentId: student.id,
      documentType: DocumentType.NATIONAL_ID,
      storageKey: '3'.repeat(64),
    });
    const archivedPhoto = fakeDb.addDocument({
      studentId: student.id,
      documentType: DocumentType.PERSONAL_PHOTO,
      archivedAt: new Date('2026-11-26T10:00:00.000Z'),
      storageKey: '4'.repeat(64),
    });
    const unavailablePhoto = fakeDb.addDocument({
      studentId: student.id,
      documentType: DocumentType.PERSONAL_PHOTO,
      archivedAt: new Date('2026-11-26T10:00:00.000Z'),
      availability: DocumentAvailability.DELETE_PENDING,
      storageKey: '5'.repeat(64),
    });
    const otherStudentPhoto = fakeDb.addDocument({
      studentId: other.id,
      documentType: DocumentType.PERSONAL_PHOTO,
      storageKey: '6'.repeat(64),
    });

    // Reject missing, wrong owner, non-photo, archived, unavailable, stale version
    await expect(
      service.setSelectedPhoto(actor, student.id, {
        expectedVersion: student.version,
        documentId: 9999,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    await expect(
      service.setSelectedPhoto(actor, student.id, {
        expectedVersion: student.version,
        documentId: otherStudentPhoto.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.DOCUMENT_OWNER_MISMATCH });

    await expect(
      service.setSelectedPhoto(actor, student.id, {
        expectedVersion: student.version,
        documentId: nonPhoto.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_SELECTED_PHOTO });

    await expect(
      service.setSelectedPhoto(actor, student.id, {
        expectedVersion: student.version,
        documentId: archivedPhoto.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.DOCUMENT_ARCHIVED });

    // Unarchived-but-unavailable (e.g., DELETE_PENDING) photo check
    const pendingPhoto = fakeDb.addDocument({
      studentId: student.id,
      documentType: DocumentType.PERSONAL_PHOTO,
      availability: DocumentAvailability.DELETE_PENDING,
      storageKey: '7'.repeat(64),
    });
    await expect(
      service.setSelectedPhoto(actor, student.id, {
        expectedVersion: student.version,
        documentId: pendingPhoto.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.DOCUMENT_UNAVAILABLE });
    expect(unavailablePhoto.id).toBeGreaterThan(0);

    // Select photo1
    const selected1 = await service.setSelectedPhoto(actor, student.id, {
      expectedVersion: student.version,
      documentId: photo1.id,
    });
    expect(selected1).toMatchObject({
      id: student.id,
      selectedPhotoDocumentId: photo1.id,
      version: 2,
    });

    // Stale version fails
    await expect(
      service.setSelectedPhoto(actor, student.id, {
        expectedVersion: 1,
        documentId: photo2.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STALE_VERSION });

    // Switch to photo2
    const selected2 = await service.setSelectedPhoto(actor, student.id, {
      expectedVersion: selected1.version,
      documentId: photo2.id,
    });
    expect(selected2).toMatchObject({
      selectedPhotoDocumentId: photo2.id,
      version: 3,
    });

    // Clear selected photo
    const cleared = await service.setSelectedPhoto(actor, student.id, {
      expectedVersion: selected2.version,
      documentId: null,
    });
    expect(cleared).toMatchObject({
      selectedPhotoDocumentId: null,
      version: 4,
    });

    // Archived student blocks changing selected photo
    const archivedStudent = await service.archiveStudent(
      actor,
      student.id,
      cleared.version,
    );
    await expect(
      service.setSelectedPhoto(actor, student.id, {
        expectedVersion: archivedStudent.version,
        documentId: photo1.id,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STUDENT_ARCHIVED });

    const history = await service.getStudentHistory(student.id, {
      includeArchived: true,
    });
    expect(history.items.map((item) => item.action)).toEqual([
      'ARCHIVED',
      'UPDATED',
      'UPDATED',
      'UPDATED',
      'CREATED',
    ]);
  });
});
