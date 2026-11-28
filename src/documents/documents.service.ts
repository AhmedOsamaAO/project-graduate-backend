import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import type { ReadStream } from 'node:fs';
import {
  appendStaffRecordHistory,
  type ChangeHistoryEntryView,
  type StaffActor,
} from '../change-history/change-history';
import { ChangeHistoryService } from '../change-history/change-history.service';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import { createPage, type PageResult } from '../common/http/page';
import type { PageQueryDto } from '../common/http/page-query.dto';
import {
  DocumentAvailability,
  DocumentType,
  type FileOperationKind,
  type Document,
  type Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionRunner } from '../prisma/transaction-runner';
import { validateOptionalBoolean } from '../students/qualifications.validation';
import { StudentsService } from '../students/students.service';
import {
  normalizePagination,
  notFoundError,
  validateArchiveFilter,
  validatePositiveInt4,
  validationError,
  type SortDirection,
} from '../students/students.validation';
import { DocumentArchiveGuardRegistry } from './document-archive-guard';
import {
  assertActiveStudentQualificationInTx,
  assertSupervisorExistsInTx,
  buildContentDisposition,
  buildDocumentOrderBy,
  documentAlreadyArchivedError,
  documentArchivedError,
  documentDeletePendingError,
  documentDeletedError,
  documentNotArchivedError,
  documentSelectedAsPhotoError,
  invalidDocumentTypeForMimeError,
  validateDocumentDisposition,
  validateDocumentType,
  validateFileOperationKind,
  validateIdempotencyKey,
  validateOptionalDocumentDescription,
  validateOptionalQualificationId,
  validateOptionalStudentDocumentTypeFilter,
  validateStudentDocumentType,
  type DocumentArchiveFilter,
  type DocumentDownloadDisposition,
  type DocumentSortField,
} from './documents.validation';
import {
  documentView,
  fileOperationView,
  toDocumentArchiveContext,
  type DocumentView,
  type FileOperationView,
} from './documents.views';
import {
  PERSONAL_PHOTO_MIME_TYPES,
  type SupportedDocumentMimeType,
} from './file-format.validator';
import {
  DOCUMENTS_CLOCK,
  FileOperationExecutor,
  type DocumentsClock,
  type UploadExecutionResult,
} from './file-operation-executor';
import type { UploadSource } from './multipart-upload';
import { PrivateFileStorage } from './private-file-storage';

export interface ListStudentDocumentsInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly documentType?: DocumentType;
  readonly qualificationId?: number;
  readonly archiveStatus?: DocumentArchiveFilter;
  readonly includeArchivedStudent?: boolean;
  readonly includeArchivedQualification?: boolean;
  readonly sortBy?: DocumentSortField;
  readonly sortOrder?: SortDirection;
}

export interface ListSupervisorDocumentsInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly archiveStatus?: DocumentArchiveFilter;
  readonly sortBy?: DocumentSortField;
  readonly sortOrder?: SortDirection;
}

export interface GetDocumentOptions {
  readonly includeArchived?: boolean;
}

export interface DownloadDocumentOptions {
  readonly includeArchived?: boolean;
  readonly disposition?: DocumentDownloadDisposition;
}

export interface ResolvedDocumentDownload {
  readonly stream: ReadStream;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentDisposition: string;
}

export interface UpdateDocumentInput {
  readonly expectedVersion: number;
  readonly qualificationId?: number | null;
  readonly documentType?: DocumentType;
  readonly description?: string | null;
}

export interface DocumentHistoryQueryInput extends Partial<
  Pick<PageQueryDto, 'page' | 'pageSize'>
> {
  readonly includeArchived?: boolean;
}

@Injectable()
export class DocumentsService {
  private readonly transactions: TransactionRunner;
  private readonly clock: DocumentsClock;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly changeHistory: ChangeHistoryService,
    private readonly students: StudentsService,
    private readonly archiveGuards: DocumentArchiveGuardRegistry,
    private readonly storage: PrivateFileStorage,
    private readonly executor: FileOperationExecutor,
    @Optional() @Inject(DOCUMENTS_CLOCK) clock?: DocumentsClock,
  ) {
    this.transactions = new TransactionRunner(prisma);
    this.clock = clock ?? { now: () => new Date() };
  }

  async listStudentDocuments(
    studentId: number,
    query: ListStudentDocumentsInput = {},
  ): Promise<PageResult<DocumentView>> {
    const validStudentId = validatePositiveInt4(studentId, 'studentId');
    const pagination = normalizePagination(query);
    const documentType = validateOptionalStudentDocumentTypeFilter(
      query.documentType,
    );
    const qualificationId =
      query.qualificationId !== undefined
        ? validatePositiveInt4(query.qualificationId, 'qualificationId')
        : undefined;
    const archiveStatus = validateArchiveFilter(query.archiveStatus);
    const includeArchivedStudent =
      validateOptionalBoolean(
        query.includeArchivedStudent,
        'includeArchivedStudent',
      ) ?? false;
    const includeArchivedQualification =
      validateOptionalBoolean(
        query.includeArchivedQualification,
        'includeArchivedQualification',
      ) ?? false;
    const orderBy = buildDocumentOrderBy(query.sortBy, query.sortOrder);

    const where: Prisma.DocumentWhereInput = {
      studentId: validStudentId,
      ...(archiveStatus === 'ACTIVE' ? { archivedAt: null } : {}),
      ...(archiveStatus === 'ARCHIVED' ? { archivedAt: { not: null } } : {}),
      ...(documentType !== undefined ? { documentType } : {}),
      ...(qualificationId !== undefined ? { qualificationId } : {}),
      ...(!includeArchivedQualification
        ? {
            OR: [
              { qualificationId: null },
              { qualification: { archivedAt: null } },
            ],
          }
        : {}),
    };

    const { total, rows } = await this.prisma.$transaction(async (tx) => {
      const student = await tx.student.findUnique({
        where: { id: validStudentId },
        select: { id: true, archivedAt: true },
      });
      if (
        !student ||
        (!includeArchivedStudent && student.archivedAt !== null)
      ) {
        throw notFoundError('Student not found');
      }

      const count = await tx.document.count({ where });
      const items = await tx.document.findMany({
        where,
        orderBy,
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
      });
      return { total: count, rows: items };
    });

    return createPage(
      rows.map(documentView),
      total,
      pagination.page,
      pagination.pageSize,
    );
  }

  async listSupervisorDocuments(
    supervisorId: number,
    query: ListSupervisorDocumentsInput = {},
  ): Promise<PageResult<DocumentView>> {
    const validSupervisorId = validatePositiveInt4(
      supervisorId,
      'supervisorId',
    );
    const pagination = normalizePagination(query);
    const archiveStatus = validateArchiveFilter(query.archiveStatus);
    const orderBy = buildDocumentOrderBy(query.sortBy, query.sortOrder);

    const where: Prisma.DocumentWhereInput = {
      supervisorId: validSupervisorId,
      ...(archiveStatus === 'ACTIVE' ? { archivedAt: null } : {}),
      ...(archiveStatus === 'ARCHIVED' ? { archivedAt: { not: null } } : {}),
    };

    const { total, rows } = await this.prisma.$transaction(async (tx) => {
      await assertSupervisorExistsInTx(tx, validSupervisorId);
      const count = await tx.document.count({ where });
      const items = await tx.document.findMany({
        where,
        orderBy,
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
      });
      return { total: count, rows: items };
    });

    return createPage(
      rows.map(documentView),
      total,
      pagination.page,
      pagination.pageSize,
    );
  }

  async getDocument(
    id: number,
    options: GetDocumentOptions = {},
  ): Promise<DocumentView> {
    const validId = validatePositiveInt4(id, 'id');
    const includeArchived =
      validateOptionalBoolean(options.includeArchived, 'includeArchived') ??
      false;

    const row = await this.findVisibleDocumentOrThrow(validId, includeArchived);
    return documentView(row);
  }

  async resolveDocumentDownload(
    id: number,
    options: DownloadDocumentOptions = {},
  ): Promise<ResolvedDocumentDownload> {
    const validId = validatePositiveInt4(id, 'id');
    const includeArchived =
      validateOptionalBoolean(options.includeArchived, 'includeArchived') ??
      false;
    const disposition = validateDocumentDisposition(options.disposition);

    const row = await this.findVisibleDocumentOrThrow(validId, includeArchived);
    assertAvailableDocument(row.availability);

    const stream = await this.storage.openReadableObject(
      row.storageKey,
      row.byteSize,
    );
    const contentDisposition = buildContentDisposition(
      row.originalFileName,
      row.mimeType,
      disposition,
    );

    return {
      stream,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      contentDisposition,
    };
  }

  private async findVisibleDocumentOrThrow(
    id: number,
    includeArchived: boolean,
  ): Promise<Document> {
    const row = await this.prisma.document.findUnique({
      where: { id },
      include: {
        student: { select: { archivedAt: true } },
        qualification: { select: { archivedAt: true } },
      },
    });
    if (!row || !isDocumentVisible(row, includeArchived)) {
      throw notFoundError('Document not found');
    }
    return row;
  }

  uploadStudentDocument(
    actor: StaffActor,
    studentId: number,
    idempotencyKey: string,
    source: UploadSource,
  ): Promise<UploadExecutionResult> {
    return this.executor.executeStudentUpload(
      actor,
      studentId,
      idempotencyKey,
      source,
    );
  }

  uploadSupervisorDocument(
    actor: StaffActor,
    supervisorId: number,
    idempotencyKey: string,
    source: UploadSource,
  ): Promise<UploadExecutionResult> {
    return this.executor.executeSupervisorUpload(
      actor,
      supervisorId,
      idempotencyKey,
      source,
    );
  }

  async updateDocument(
    actor: StaffActor,
    id: number,
    input: UpdateDocumentInput,
  ): Promise<DocumentView> {
    const validId = validatePositiveInt4(id, 'id');
    const expectedVersion = validatePositiveInt4(
      input.expectedVersion,
      'expectedVersion',
    );
    if (
      input.qualificationId === undefined &&
      input.documentType === undefined &&
      input.description === undefined
    ) {
      throw validationError(
        'body',
        'At least one field to update must be provided',
      );
    }

    const qualificationId = validateOptionalQualificationId(
      input.qualificationId,
    );
    const documentType =
      input.documentType !== undefined
        ? validateDocumentType(input.documentType)
        : undefined;
    const description = validateOptionalDocumentDescription(input.description);

    return this.runVersionedMutation(
      validId,
      expectedVersion,
      { qualificationId, documentType, description },
      async (tx, before, studentSelectedPhotoId, data) => {
        if (before.archivedAt !== null) {
          throw documentArchivedError();
        }

        let updateData: Prisma.DocumentUpdateInput;

        if (before.studentId !== null) {
          if (data.description !== undefined) {
            throw validationError(
              'description',
              'description is only supported for supervisor documents',
            );
          }

          const nextStudentDocumentType =
            data.documentType !== undefined
              ? validateStudentDocumentType(data.documentType)
              : before.documentType;

          if (
            data.qualificationId !== undefined &&
            data.qualificationId !== null &&
            data.qualificationId !== before.qualificationId
          ) {
            await assertActiveStudentQualificationInTx(
              tx,
              data.qualificationId,
              before.studentId,
            );
          }

          if (
            nextStudentDocumentType === DocumentType.PERSONAL_PHOTO &&
            !PERSONAL_PHOTO_MIME_TYPES.has(
              before.mimeType as SupportedDocumentMimeType,
            )
          ) {
            throw invalidDocumentTypeForMimeError();
          }
          if (
            before.documentType === DocumentType.PERSONAL_PHOTO &&
            nextStudentDocumentType !== DocumentType.PERSONAL_PHOTO &&
            studentSelectedPhotoId === before.id
          ) {
            throw documentSelectedAsPhotoError(
              'Clear or replace the selected personal photo before changing its document type',
            );
          }

          updateData = {
            ...(data.qualificationId !== undefined
              ? {
                  qualification:
                    data.qualificationId === null
                      ? { disconnect: true }
                      : {
                          connect: {
                            id_studentId: {
                              id: data.qualificationId,
                              studentId: before.studentId,
                            },
                          },
                        },
                }
              : {}),
            ...(data.documentType !== undefined
              ? { documentType: nextStudentDocumentType }
              : {}),
            version: { increment: 1 },
          };
        } else {
          if (data.qualificationId !== undefined) {
            throw validationError(
              'qualificationId',
              'qualificationId is not supported for supervisor documents',
            );
          }
          if (
            data.documentType !== undefined &&
            data.documentType !== DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT
          ) {
            throw validationError(
              'documentType',
              'Supervisor documents must use SUPERVISOR_SUPPORTING_DOCUMENT',
            );
          }

          updateData = {
            ...(data.description !== undefined
              ? { description: data.description }
              : {}),
            version: { increment: 1 },
          };
        }

        const after = await tx.document.update({
          where: { id: before.id },
          data: updateData,
        });

        await appendStaffRecordHistory(tx, actor, {
          recordType: 'DOCUMENT',
          recordId: after.id,
          action: 'UPDATED',
          before: documentView(before),
          after: documentView(after),
        });
        return documentView(after);
      },
      { extraQualificationId: qualificationId },
    );
  }

  async archiveDocument(
    actor: StaffActor,
    id: number,
    expectedVersion: number,
  ): Promise<DocumentView> {
    const validId = validatePositiveInt4(id, 'id');
    const validVersion = validatePositiveInt4(
      expectedVersion,
      'expectedVersion',
    );
    const archivedAt = this.clock.now();

    return this.runVersionedMutation(
      validId,
      validVersion,
      { archivedAt },
      async (tx, before, _selectedPhotoId, data) => {
        if (before.archivedAt !== null) {
          throw documentAlreadyArchivedError();
        }

        await this.archiveGuards.assertCanArchive(
          tx,
          toDocumentArchiveContext(before),
        );

        const after = await tx.document.update({
          where: { id: before.id },
          data: {
            archivedAt: data.archivedAt,
            version: { increment: 1 },
          },
        });

        await appendStaffRecordHistory(tx, actor, {
          recordType: 'DOCUMENT',
          recordId: after.id,
          action: 'ARCHIVED',
          before: documentView(before),
          after: documentView(after),
        });
        return documentView(after);
      },
      { supervisorLockMode: 'UPDATE' },
    );
  }

  async restoreDocument(
    actor: StaffActor,
    id: number,
    expectedVersion: number,
  ): Promise<DocumentView> {
    const validId = validatePositiveInt4(id, 'id');
    const validVersion = validatePositiveInt4(
      expectedVersion,
      'expectedVersion',
    );

    return this.runVersionedMutation(
      validId,
      validVersion,
      undefined,
      async (tx, before) => {
        if (before.archivedAt === null) {
          throw documentNotArchivedError();
        }

        const after = await tx.document.update({
          where: { id: before.id },
          data: {
            archivedAt: null,
            version: { increment: 1 },
          },
        });

        await appendStaffRecordHistory(tx, actor, {
          recordType: 'DOCUMENT',
          recordId: after.id,
          action: 'RESTORED',
          before: documentView(before),
          after: documentView(after),
        });
        return documentView(after);
      },
    );
  }

  async getDocumentHistory(
    id: number,
    query: DocumentHistoryQueryInput = {},
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    const validId = validatePositiveInt4(id, 'id');
    const pagination = normalizePagination(query);
    const includeArchived =
      validateOptionalBoolean(query.includeArchived, 'includeArchived') ??
      false;

    const doc = await this.prisma.document.findUnique({
      where: { id: validId },
      select: {
        id: true,
        archivedAt: true,
        student: { select: { archivedAt: true } },
        qualification: { select: { archivedAt: true } },
      },
    });
    if (!doc || !isDocumentVisible(doc, includeArchived)) {
      throw notFoundError('Document not found');
    }

    return this.changeHistory.listRecordHistory(
      'DOCUMENT',
      validId,
      pagination,
      () => Promise.resolve(true),
    );
  }

  async getFileOperation(id: number): Promise<FileOperationView> {
    const validId = validatePositiveInt4(id, 'id');
    const row = await this.prisma.fileOperation.findUnique({
      where: { id: validId },
    });
    if (!row) {
      throw notFoundError('File operation not found');
    }
    return fileOperationView(row);
  }

  async getFileOperationByKey(
    actor: StaffActor,
    kind: FileOperationKind,
    idempotencyKey: string,
  ): Promise<FileOperationView> {
    const validKind = validateFileOperationKind(kind);
    const validKey = validateIdempotencyKey(idempotencyKey);

    const row = await this.prisma.fileOperation.findUnique({
      where: {
        requestedByStaffUserId_kind_idempotencyKey: {
          requestedByStaffUserId: actor.staffUserId,
          kind: validKind,
          idempotencyKey: validKey,
        },
      },
    });
    if (!row) {
      throw notFoundError('File operation not found');
    }
    return fileOperationView(row);
  }

  private async runVersionedMutation<Payload, Result>(
    id: number,
    expectedVersion: number,
    payload: Payload,
    execute: (
      tx: Prisma.TransactionClient,
      before: Document,
      studentSelectedPhotoId: number | null,
      payload: NoInfer<Payload>,
    ) => Promise<Result>,
    options: {
      readonly extraQualificationId?: number | null;
      readonly supervisorLockMode?: 'SHARE' | 'UPDATE';
    } = {},
  ): Promise<Result> {
    return this.transactions.run(
      {
        id,
        expectedVersion,
        payload,
        extraQualificationId: options.extraQualificationId,
        supervisorLockMode: options.supervisorLockMode ?? 'SHARE',
      },
      async (tx, original) => {
        const target = await tx.document.findUnique({
          where: { id: original.id },
          select: {
            id: true,
            studentId: true,
            supervisorId: true,
            qualificationId: true,
          },
        });
        if (!target) {
          throw notFoundError('Document not found');
        }

        let studentSelectedPhotoId: number | null = null;
        if (target.studentId !== null) {
          const student = await this.students.assertActiveStudentInTx(
            tx,
            target.studentId,
          );
          studentSelectedPhotoId = student.selectedPhotoDocumentId;

          const qualIdsToLock = [
            target.qualificationId,
            original.extraQualificationId,
          ]
            .filter((qid): qid is number => typeof qid === 'number')
            .filter((qid, index, arr) => arr.indexOf(qid) === index)
            .sort((a, b) => a - b);

          for (const qid of qualIdsToLock) {
            await tx.$queryRaw`SELECT id FROM student_qualification WHERE id = ${qid} FOR SHARE`;
          }

          if (target.qualificationId !== null) {
            await assertActiveStudentQualificationInTx(
              tx,
              target.qualificationId,
              target.studentId,
            );
          }
        } else if (target.supervisorId !== null) {
          if (original.supervisorLockMode === 'UPDATE') {
            await tx.$queryRaw`SELECT id FROM supervisor WHERE id = ${target.supervisorId} FOR UPDATE`;
          } else {
            await tx.$queryRaw`SELECT id FROM supervisor WHERE id = ${target.supervisorId} FOR SHARE`;
          }
          await assertSupervisorExistsInTx(tx, target.supervisorId);
        }

        const before = await lockDocument(tx, original.id);
        if (!before) {
          throw notFoundError('Document not found');
        }
        if (before.version !== original.expectedVersion) {
          throw new ApiError(
            HttpStatus.CONFLICT,
            ERROR_CODES.STALE_VERSION,
            'Document record has changed; refresh and retry with the current version',
          );
        }
        assertAvailableDocument(before.availability);

        return execute(tx, before, studentSelectedPhotoId, original.payload);
      },
    );
  }
}

async function lockDocument(
  tx: Prisma.TransactionClient,
  id: number,
): Promise<Document | null> {
  await tx.$queryRaw`SELECT id FROM document WHERE id = ${id} FOR UPDATE`;
  return tx.document.findUnique({ where: { id } });
}

function assertAvailableDocument(availability: DocumentAvailability): void {
  if (availability === DocumentAvailability.DELETE_PENDING) {
    throw documentDeletePendingError();
  }
  if (availability === DocumentAvailability.DELETED) {
    throw documentDeletedError();
  }
}

function isDocumentVisible(
  row: {
    readonly archivedAt: Date | null;
    readonly student: { readonly archivedAt: Date | null } | null;
    readonly qualification: { readonly archivedAt: Date | null } | null;
  },
  includeArchived: boolean,
): boolean {
  if (includeArchived) {
    return true;
  }
  if (row.archivedAt !== null) {
    return false;
  }
  if (row.student !== null) {
    return (
      row.student.archivedAt === null &&
      (row.qualification === null || row.qualification.archivedAt === null)
    );
  }
  return true;
}
