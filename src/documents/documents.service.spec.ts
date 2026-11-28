import { ChangeHistoryService } from '../change-history/change-history.service';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  DocumentAvailability,
  DocumentType,
  FileOperationKind,
  FileOperationStatus,
  Prisma,
  type Document,
  type FileOperation,
  type Student,
  type StudentQualification,
} from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { StudentArchiveGuardRegistry } from '../students/student-archive-guard';
import { StudentsService } from '../students/students.service';
import {
  DocumentArchiveGuardRegistry,
  createSelectedPhotoDocumentArchiveGuard,
} from './document-archive-guard';
import { DocumentsService } from './documents.service';
import type { FileOperationExecutor } from './file-operation-executor';
import type { PrivateFileStorage } from './private-file-storage';
import { Readable } from 'node:stream';

function createFakeDocumentsPrisma() {
  const now = new Date('2026-11-28T10:00:00.000Z');
  let tick = 0;
  const nextTime = () => new Date(now.getTime() + ++tick * 1000);

  let state = {
    students: [
      {
        id: 1,
        fullName: 'Student One',
        nationalId: '29901011234567',
        phone: null,
        birthDate: null,
        address: null,
        militaryStatus: null,
        selectedPhotoDocumentId: null as number | null,
        archivedAt: null as Date | null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      } satisfies Student,
      {
        id: 2,
        fullName: 'Student Two',
        nationalId: '29901011234568',
        phone: null,
        birthDate: null,
        address: null,
        militaryStatus: null,
        selectedPhotoDocumentId: null as number | null,
        archivedAt: null as Date | null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      } satisfies Student,
    ],
    qualifications: [
      {
        id: 10,
        studentId: 1,
        degreeLevel: 'BACHELOR',
        qualificationName: 'B.Sc. CS',
        institutionId: 1,
        facultyId: 1,
        departmentId: null,
        graduationYear: 2022,
        overallGrade: 'Very Good',
        equivalencyStatus: 'NOT_REQUIRED',
        equivalencyDecisionNumber: null,
        equivalencyDecisionDate: null,
        archivedAt: null as Date | null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      } satisfies StudentQualification,
      {
        id: 11,
        studentId: 2,
        degreeLevel: 'BACHELOR',
        qualificationName: 'Other Qual',
        institutionId: 1,
        facultyId: 1,
        departmentId: null,
        graduationYear: 2022,
        overallGrade: null,
        equivalencyStatus: 'NOT_REQUIRED',
        equivalencyDecisionNumber: null,
        equivalencyDecisionDate: null,
        archivedAt: null as Date | null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      } satisfies StudentQualification,
    ],
    documents: [] as Document[],
    fileOperations: [] as FileOperation[],
    history: [] as Array<{
      id: number;
      recordType: string;
      recordId: number | null;
      action: string;
      actorKind: string;
      staffUserId: number | null;
      operatorAttribution: string | null;
      occurredAt: Date;
      before: unknown;
      after: unknown;
    }>,
    nextDocId: 1,
    nextHistoryId: 1,
  };

  const staffUsers = new Map([
    [10, { id: 10, username: 'staff.one', fullName: 'Staff One' }],
  ]);

  const attachRelations = (doc: Document) => ({
    ...structuredClone(doc),
    student: {
      archivedAt:
        state.students.find((s) => s.id === doc.studentId)?.archivedAt ?? null,
    },
    qualification:
      doc.qualificationId === null
        ? null
        : {
            archivedAt:
              state.qualifications.find((q) => q.id === doc.qualificationId)
                ?.archivedAt ?? null,
          },
  });

  const makeClient = (getWorking: () => typeof state) => ({
    $queryRaw: () => Promise.resolve([]),
    student: {
      findUnique: ({ where }: { where: { id: number } }) => {
        const found = getWorking().students.find((s) => s.id === where.id);
        return Promise.resolve(found ? structuredClone(found) : null);
      },
    },
    studentQualification: {
      findUnique: ({ where }: { where: { id: number } }) => {
        const found = getWorking().qualifications.find(
          (q) => q.id === where.id,
        );
        return Promise.resolve(found ? structuredClone(found) : null);
      },
    },
    document: {
      count: ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
        Promise.resolve(filterDocs(getWorking(), where).length),
      findMany: ({
        where = {},
        skip = 0,
        take = 20,
      }: {
        where?: Record<string, unknown>;
        skip?: number;
        take?: number;
      }) => {
        const filtered = filterDocs(getWorking(), where);
        return Promise.resolve(
          filtered.slice(skip, skip + take).map((d) => structuredClone(d)),
        );
      },
      findUnique: ({
        where,
        include,
        select,
      }: {
        where: { id: number };
        include?: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) => {
        const found = getWorking().documents.find((d) => d.id === where.id);
        if (!found) return Promise.resolve(null);
        return Promise.resolve(
          include || (select && 'student' in select)
            ? attachRelations(found)
            : structuredClone(found),
        );
      },
      update: ({
        where,
        data,
      }: {
        where: { id: number };
        data: Record<string, unknown> & { version?: { increment: number } };
      }) => {
        const working = getWorking();
        const idx = working.documents.findIndex((d) => d.id === where.id);
        if (idx === -1) return Promise.reject(new Error('Missing document'));
        const current = working.documents[idx];
        const updated: Document = {
          ...current,
          qualificationId:
            data.qualificationId !== undefined
              ? (data.qualificationId as number | null)
              : current.qualificationId,
          documentType:
            (data.documentType as DocumentType | undefined) ??
            current.documentType,
          archivedAt:
            data.archivedAt !== undefined
              ? (data.archivedAt as Date | null)
              : current.archivedAt,
          version: current.version + (data.version?.increment ?? 0),
          updatedAt: nextTime(),
        };
        working.documents[idx] = updated;
        return Promise.resolve(structuredClone(updated));
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
        const row = getWorking().fileOperations.find((op) => {
          if (where.id !== undefined) return op.id === where.id;
          const k = where.requestedByStaffUserId_kind_idempotencyKey!;
          return (
            op.requestedByStaffUserId === k.requestedByStaffUserId &&
            op.kind === k.kind &&
            op.idempotencyKey === k.idempotencyKey
          );
        });
        return Promise.resolve(row ? structuredClone(row) : null);
      },
    },
    changeHistory: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        const working = getWorking();
        working.history.push({
          id: working.nextHistoryId++,
          recordType: data.recordType as string,
          recordId: (data.recordId as number | null) ?? null,
          action: data.action as string,
          actorKind: data.actorKind as string,
          staffUserId: (data.staffUserId as number | null) ?? null,
          operatorAttribution:
            (data.operatorAttribution as string | null) ?? null,
          occurredAt: nextTime(),
          before: data.before,
          after: data.after,
        });
        return Promise.resolve({});
      },
      count: ({ where }: { where: { recordType: string; recordId: number } }) =>
        Promise.resolve(
          getWorking().history.filter(
            (h) =>
              h.recordType === where.recordType &&
              h.recordId === where.recordId,
          ).length,
        ),
      findMany: ({
        where,
        skip = 0,
        take = 20,
      }: {
        where: { recordType: string; recordId: number };
        skip?: number;
        take?: number;
      }) =>
        Promise.resolve(
          getWorking()
            .history.filter(
              (h) =>
                h.recordType === where.recordType &&
                h.recordId === where.recordId,
            )
            .sort(
              (a, b) =>
                b.occurredAt.getTime() - a.occurredAt.getTime() || b.id - a.id,
            )
            .slice(skip, skip + take)
            .map((h) => ({
              ...structuredClone(h),
              staffUser: h.staffUserId
                ? (staffUsers.get(h.staffUserId) ?? null)
                : null,
            })),
        ),
    },
  });

  function filterDocs(working: typeof state, where: Record<string, unknown>) {
    return working.documents.filter((doc) => {
      if (where.studentId !== undefined && doc.studentId !== where.studentId) {
        return false;
      }
      if (
        where.documentType !== undefined &&
        doc.documentType !== where.documentType
      ) {
        return false;
      }
      if (
        'qualificationId' in where &&
        doc.qualificationId !== where.qualificationId
      ) {
        return false;
      }
      if ('archivedAt' in where) {
        if (where.archivedAt === null && doc.archivedAt !== null) return false;
        if (
          typeof where.archivedAt === 'object' &&
          where.archivedAt !== null &&
          doc.archivedAt === null
        ) {
          return false;
        }
      }
      if ('OR' in where && Array.isArray(where.OR)) {
        const qual =
          doc.qualificationId === null
            ? null
            : working.qualifications.find((q) => q.id === doc.qualificationId);
        if (doc.qualificationId !== null && qual?.archivedAt !== null) {
          return false;
        }
      }
      return true;
    });
  }

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
    addDocument: (
      overrides: Partial<Document> & {
        studentId: number;
        documentType: DocumentType;
      },
    ): Document => {
      const t = nextTime();
      const doc: Document = {
        id: state.nextDocId++,
        studentId: overrides.studentId,
        qualificationId: overrides.qualificationId ?? null,
        documentType: overrides.documentType,
        originalFileName: overrides.originalFileName ?? 'doc.pdf',
        storageKey:
          overrides.storageKey ?? String(state.nextDocId).padStart(64, '0'),
        mimeType: overrides.mimeType ?? 'application/pdf',
        byteSize: overrides.byteSize ?? 1234,
        uploadedAt: overrides.uploadedAt ?? t,
        archivedAt: overrides.archivedAt ?? null,
        availability: overrides.availability ?? DocumentAvailability.AVAILABLE,
        deletedAt: overrides.deletedAt ?? null,
        deletedByStaffUserId: overrides.deletedByStaffUserId ?? null,
        version: overrides.version ?? 1,
        createdAt: t,
        updatedAt: t,
      };
      state.documents.push(doc);
      return doc;
    },
  };
}

describe('DocumentsService', () => {
  const actor = { staffUserId: 10 };
  const fixedNow = new Date('2026-11-28T12:00:00.000Z');

  let fakeDb: ReturnType<typeof createFakeDocumentsPrisma>;
  let archiveGuards: DocumentArchiveGuardRegistry;
  let storageMock: Pick<PrivateFileStorage, 'openReadableObject'>;
  let service: DocumentsService;

  beforeEach(() => {
    fakeDb = createFakeDocumentsPrisma();
    archiveGuards = new DocumentArchiveGuardRegistry();
    archiveGuards.register(createSelectedPhotoDocumentArchiveGuard());

    storageMock = {
      openReadableObject: () =>
        Promise.resolve(
          Readable.from([Buffer.from('pdf-bytes')]) as unknown as ReturnType<
            PrivateFileStorage['openReadableObject']
          > extends Promise<infer R>
            ? R
            : never,
        ),
    };

    const historyService = new ChangeHistoryService(fakeDb.prisma);
    const studentsService = new StudentsService(
      fakeDb.prisma,
      historyService,
      new StudentArchiveGuardRegistry(),
    );
    const executorMock = {} as FileOperationExecutor;
    service = new DocumentsService(
      fakeDb.prisma,
      historyService,
      studentsService,
      archiveGuards,
      storageMock as PrivateFileStorage,
      executorMock,
      { now: () => fixedNow },
    );
  });

  it('enforces metadata update rules, same-student qualification linking, photo MIME rules, and selected-photo guard', async () => {
    const pdfDoc = fakeDb.addDocument({
      studentId: 1,
      documentType: DocumentType.TRANSCRIPT,
      mimeType: 'application/pdf',
    });
    const photoDoc = fakeDb.addDocument({
      studentId: 1,
      documentType: DocumentType.PERSONAL_PHOTO,
      originalFileName: 'photo.png',
      mimeType: 'image/png',
    });

    // Link same-student qualification
    const linked = await service.updateDocument(actor, pdfDoc.id, {
      expectedVersion: 1,
      qualificationId: 10,
      documentType: DocumentType.BACHELOR_CERTIFICATE,
    });
    expect(linked).toMatchObject({
      qualificationId: 10,
      documentType: DocumentType.BACHELOR_CERTIFICATE,
      version: 2,
    });
    expect(linked).not.toHaveProperty('storageKey');

    // Cross-student qualification rejected
    await expect(
      service.updateDocument(actor, pdfDoc.id, {
        expectedVersion: 2,
        qualificationId: 11,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.DOCUMENT_QUALIFICATION_STUDENT_MISMATCH,
    });

    // Cannot categorize PDF as PERSONAL_PHOTO
    await expect(
      service.updateDocument(actor, pdfDoc.id, {
        expectedVersion: 2,
        documentType: DocumentType.PERSONAL_PHOTO,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_DOCUMENT_TYPE_FOR_MIME,
    });

    // Selected photo blocks archiving and blocks changing category away from PERSONAL_PHOTO
    fakeDb.getState().students[0].selectedPhotoDocumentId = photoDoc.id;
    await expect(
      service.archiveDocument(actor, photoDoc.id, 1),
    ).rejects.toMatchObject({ code: ERROR_CODES.DOCUMENT_SELECTED_AS_PHOTO });
    await expect(
      service.updateDocument(actor, photoDoc.id, {
        expectedVersion: 1,
        documentType: DocumentType.OTHER,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.DOCUMENT_SELECTED_AS_PHOTO });

    // Clearing selected photo unlocks archiving and restoring
    fakeDb.getState().students[0].selectedPhotoDocumentId = null;
    const archived = await service.archiveDocument(actor, photoDoc.id, 1);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.version).toBe(2);

    await expect(service.getDocument(photoDoc.id)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    });
    await expect(
      service.getDocument(photoDoc.id, { includeArchived: true }),
    ).resolves.toMatchObject({ id: photoDoc.id });

    const restored = await service.restoreDocument(actor, photoDoc.id, 2);
    expect(restored).toMatchObject({ archivedAt: null, version: 3 });

    const history = await service.getDocumentHistory(photoDoc.id);
    expect(history.items.map((h) => h.action)).toEqual([
      'RESTORED',
      'ARCHIVED',
    ]);
  });

  it('keeps documents readable/downloadable under archived parents while blocking mutations until restored', async () => {
    const doc = fakeDb.addDocument({
      studentId: 1,
      qualificationId: 10,
      documentType: DocumentType.OTHER,
      originalFileName: 'grades.xlsx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    // Archive qualification
    fakeDb.getState().qualifications[0].archivedAt = new Date();
    await expect(service.getDocument(doc.id)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    });
    await expect(
      service.getDocument(doc.id, { includeArchived: true }),
    ).resolves.toMatchObject({ id: doc.id });

    const dlUnderArchivedQual = await service.resolveDocumentDownload(doc.id, {
      includeArchived: true,
      disposition: 'inline',
    });
    expect(
      dlUnderArchivedQual.contentDisposition.startsWith('attachment;'),
    ).toBe(true);
    dlUnderArchivedQual.stream.destroy();

    await expect(
      service.archiveDocument(actor, doc.id, 1),
    ).rejects.toMatchObject({ code: ERROR_CODES.QUALIFICATION_ARCHIVED });

    // Restore qualification, archive student -> still downloadable with includeArchived, mutations blocked
    fakeDb.getState().qualifications[0].archivedAt = null;
    fakeDb.getState().students[0].archivedAt = new Date();

    await expect(
      service.resolveDocumentDownload(doc.id, { includeArchived: true }),
    ).resolves.toMatchObject({
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    await expect(
      service.archiveDocument(actor, doc.id, 1),
    ).rejects.toMatchObject({ code: ERROR_CODES.STUDENT_ARCHIVED });
  });

  it('returns sanitized file operation lookups without storage keys', async () => {
    fakeDb.getState().fileOperations.push({
      id: 77,
      kind: FileOperationKind.UPLOAD,
      status: FileOperationStatus.COMPLETED,
      requestedByStaffUserId: actor.staffUserId,
      studentId: 1,
      documentId: 9,
      idempotencyKey: 'op-key',
      requestFingerprint: 'a'.repeat(64),
      stagingKey: 'b'.repeat(64),
      storageKey: 'c'.repeat(64),
      executorId: 'worker',
      claimToken: null,
      leaseExpiresAt: null,
      errorStatus: null,
      errorCode: null,
      errorMessage: null,
      createdAt: fixedNow,
      updatedAt: fixedNow,
      completedAt: fixedNow,
    });

    const byId = await service.getFileOperation(77);
    const byKey = await service.getFileOperationByKey(
      actor,
      FileOperationKind.UPLOAD,
      'op-key',
    );
    expect(byId).toEqual(byKey);
    expect(byId).toMatchObject({
      id: 77,
      kind: FileOperationKind.UPLOAD,
      status: FileOperationStatus.COMPLETED,
      studentId: 1,
      documentId: 9,
    });
    expect(byId).not.toHaveProperty('storageKey');
    expect(byId).not.toHaveProperty('stagingKey');
  });
});
