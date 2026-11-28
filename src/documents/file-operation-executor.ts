import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendStaffRecordHistory,
  type StaffActor,
} from '../change-history/change-history';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.module';
import {
  DocumentAvailability,
  FileOperationKind,
  FileOperationStatus,
  type FileOperation,
  type Prisma,
} from '../generated/prisma/client';
import {
  isDefiniteRollbackDatabaseError,
  isUniqueConstraintError,
} from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionRunner } from '../prisma/transaction-runner';
import { StudentsService } from '../students/students.service';
import {
  notFoundError,
  studentArchivedError,
  validatePositiveInt4,
} from '../students/students.validation';
import {
  assertActiveStudentQualificationInTx,
  computeUploadRequestFingerprint,
  idempotencyKeyConflictError,
  uploadInterruptedError,
  validateIdempotencyKey,
} from './documents.validation';
import {
  documentView,
  fileOperationView,
  type DocumentView,
  type FileOperationView,
} from './documents.views';
import { validateFileFormat } from './file-format.validator';
import type { ReceivedUploadFile, UploadSource } from './multipart-upload';
import { PrivateFileStorage } from './private-file-storage';

export const DOCUMENTS_CLOCK = Symbol('DOCUMENTS_CLOCK');
export const FILE_OPERATION_FAULT_HOOK = Symbol('FILE_OPERATION_FAULT_HOOK');

export interface DocumentsClock {
  now(): Date;
}

export type FileOperationFaultCutPoint =
  | 'AFTER_ADMIT'
  | 'AFTER_STAGING_WRITE'
  | 'AFTER_PREPARE_BEFORE_PUBLISH'
  | 'AFTER_CLEANUP_CLAIM_BEFORE_UNLINK'
  | 'AFTER_PUBLISH_BEFORE_RESPONSE';

export interface FileOperationFaultHook {
  onCutPoint(
    cutPoint: FileOperationFaultCutPoint,
    context: { readonly operationId: number },
  ): Promise<void> | void;
}

export type UploadExecutionResult =
  | {
      readonly kind: 'COMPLETED';
      readonly operationId: number;
      readonly document: DocumentView;
    }
  | {
      readonly kind: 'PENDING';
      readonly operation: FileOperationView;
    };

interface SanitizedFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

@Injectable()
export class FileOperationExecutor
  implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly logger = new Logger(FileOperationExecutor.name);
  private readonly transactions: TransactionRunner;
  private readonly clock: DocumentsClock;
  private readonly faultHook: FileOperationFaultHook;
  private readonly executorId = randomUUID();
  private readonly inFlightIds = new Set<number>();
  private readonly activeTasks = new Set<Promise<unknown>>();

  private reconciliationInFlight: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private shuttingDown = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly storage: PrivateFileStorage,
    private readonly students: StudentsService,
    @Optional() @Inject(DOCUMENTS_CLOCK) clock?: DocumentsClock,
    @Optional()
    @Inject(FILE_OPERATION_FAULT_HOOK)
    faultHook?: FileOperationFaultHook,
  ) {
    this.transactions = new TransactionRunner(prisma);
    this.clock = clock ?? { now: () => new Date() };
    this.faultHook = faultHook ?? { onCutPoint: () => undefined };
  }

  async onModuleInit(): Promise<void> {
    this.shuttingDown = false;
    await this.storage.ensureDirectories();
    await this.reconcileNow({ includeForeignActive: true });

    const intervalMs =
      this.config.fileOperationReconciliationIntervalSeconds * 1000;
    this.timer = setInterval(() => {
      void this.runPeriodicSweep();
    }, intervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopTimer();
    await this.drain();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopTimer();
    await this.drain();
  }

  async drain(): Promise<void> {
    while (
      this.activeTasks.size > 0 ||
      this.reconciliationInFlight !== undefined
    ) {
      const pending: Array<Promise<unknown>> = [...this.activeTasks];
      if (this.reconciliationInFlight) {
        pending.push(this.reconciliationInFlight);
      }
      await Promise.allSettled(pending);
    }
  }

  async reconcileNow(
    options: { readonly includeForeignActive?: boolean } = {},
  ): Promise<void> {
    if (this.reconciliationInFlight) {
      await this.reconciliationInFlight;
    }

    const includeForeignActive = options.includeForeignActive ?? false;
    const run = this.executeReconciliation(includeForeignActive).finally(() => {
      if (this.reconciliationInFlight === run) {
        this.reconciliationInFlight = undefined;
      }
    });
    this.reconciliationInFlight = run;
    await run;
  }

  executeStudentUpload(
    actor: StaffActor,
    studentId: number,
    idempotencyKey: string,
    source: UploadSource,
  ): Promise<UploadExecutionResult> {
    const validStudentId = validatePositiveInt4(studentId, 'studentId');
    const validKey = validateIdempotencyKey(idempotencyKey);

    if (this.shuttingDown) {
      return Promise.reject(
        new ApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          ERROR_CODES.SERVICE_UNAVAILABLE,
          'Service is shutting down and cannot accept new uploads',
        ),
      );
    }

    const work = this.runStudentUpload(
      actor,
      validStudentId,
      validKey,
      source,
    ).finally(() => {
      this.activeTasks.delete(work);
    });
    this.activeTasks.add(work);
    return work;
  }

  private stopTimer(): void {
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async runPeriodicSweep(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    try {
      await this.reconcileNow({ includeForeignActive: false });
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : 'UnknownError';
      this.logger.error(`File operation reconciliation sweep failed (${name})`);
    }
  }

  private async runStudentUpload(
    actor: StaffActor,
    studentId: number,
    idempotencyKey: string,
    source: UploadSource,
  ): Promise<UploadExecutionResult> {
    const existing = await this.prisma.fileOperation.findUnique({
      where: {
        requestedByStaffUserId_kind_idempotencyKey: {
          requestedByStaffUserId: actor.staffUserId,
          kind: FileOperationKind.UPLOAD,
          idempotencyKey,
        },
      },
    });
    if (existing) {
      return this.resolveExistingUploadOperation(existing, studentId, source);
    }

    const studentCheck = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, archivedAt: true },
    });
    if (!studentCheck) {
      throw notFoundError('Student not found');
    }
    if (studentCheck.archivedAt !== null) {
      throw studentArchivedError(
        'Archived student must be restored before uploading documents',
      );
    }

    const stagingKey = this.storage.generateKey();
    const storageKey = this.storage.generateKey();
    const claimToken = randomBytes(32).toString('hex');
    const admitted = await this.admitUploadOperation({
      actor,
      studentId,
      idempotencyKey,
      stagingKey,
      storageKey,
      claimToken,
    });

    if (!admitted.freshlyCreated) {
      return this.resolveExistingUploadOperation(
        admitted.operation,
        studentId,
        source,
      );
    }

    const operation = admitted.operation;
    this.inFlightIds.add(operation.id);
    let enteredPublish = false;

    try {
      await this.triggerCutPoint('AFTER_ADMIT', operation.id);

      const received = await this.streamAndHashStagingFile(stagingKey, source);
      const requestFingerprint = this.computeReceivedFingerprint(
        studentId,
        received,
      );

      await this.persistFingerprintAndRenewLease(
        operation.id,
        claimToken,
        requestFingerprint,
      );
      await this.triggerCutPoint('AFTER_STAGING_WRITE', operation.id);

      const validated = await validateFileFormat(
        this.storage.stagingPath(stagingKey),
        received.documentType,
        this.config.uploadMaxBytes,
      );

      await this.storage.promoteStagingToObject(stagingKey, storageKey);
      await this.triggerCutPoint('AFTER_PREPARE_BEFORE_PUBLISH', operation.id);

      enteredPublish = true;
      const published = await this.publishDocumentTransaction({
        actor,
        operationId: operation.id,
        claimToken,
        studentId,
        storageKey,
        requestFingerprint,
        received,
        mimeType: validated.mimeType,
        byteSize: validated.byteSize,
      });

      await this.triggerCutPoint('AFTER_PUBLISH_BEFORE_RESPONSE', operation.id);

      return {
        kind: 'COMPLETED',
        operationId: operation.id,
        document: published,
      };
    } catch (error: unknown) {
      if (
        enteredPublish &&
        !(error instanceof ApiError) &&
        !isDefiniteRollbackDatabaseError(error)
      ) {
        const resolved = await this.probeAmbiguousPublishCommit(operation.id);
        if (resolved) {
          return resolved;
        }
        throw new ApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          ERROR_CODES.SERVICE_UNAVAILABLE,
          'Upload outcome is temporarily unavailable; check operation status or retry with the same Idempotency-Key',
          { operationId: operation.id },
        );
      }

      const sanitized = sanitizeOperationFailure(error);
      await this.cleanupFailedUpload(
        operation.id,
        claimToken,
        stagingKey,
        storageKey,
        sanitized,
      );

      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(sanitized.status, sanitized.code, sanitized.message, {
        operationId: operation.id,
      });
    } finally {
      this.inFlightIds.delete(operation.id);
    }
  }

  private async admitUploadOperation(input: {
    readonly actor: StaffActor;
    readonly studentId: number;
    readonly idempotencyKey: string;
    readonly stagingKey: string;
    readonly storageKey: string;
    readonly claimToken: string;
  }): Promise<
    | { readonly freshlyCreated: true; readonly operation: FileOperation }
    | { readonly freshlyCreated: false; readonly operation: FileOperation }
  > {
    const leaseExpiresAt = this.nextLeaseExpiry();

    try {
      const created = await this.prisma.fileOperation.create({
        data: {
          kind: FileOperationKind.UPLOAD,
          status: FileOperationStatus.IN_PROGRESS,
          requestedByStaffUserId: input.actor.staffUserId,
          studentId: input.studentId,
          idempotencyKey: input.idempotencyKey,
          stagingKey: input.stagingKey,
          storageKey: input.storageKey,
          executorId: this.executorId,
          claimToken: input.claimToken,
          leaseExpiresAt,
        },
      });
      return { freshlyCreated: true, operation: created };
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        const raced = await this.prisma.fileOperation.findUnique({
          where: {
            requestedByStaffUserId_kind_idempotencyKey: {
              requestedByStaffUserId: input.actor.staffUserId,
              kind: FileOperationKind.UPLOAD,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (raced) {
          return { freshlyCreated: false, operation: raced };
        }
      }
      throw error;
    }
  }

  private async resolveExistingUploadOperation(
    existing: FileOperation,
    studentId: number,
    source: UploadSource,
  ): Promise<UploadExecutionResult> {
    const received = await source.hashWithoutStoring(
      this.config.uploadMaxBytes,
    );
    const incomingFingerprint = this.computeReceivedFingerprint(
      studentId,
      received,
    );

    if (existing.studentId !== studentId) {
      throw idempotencyKeyConflictError();
    }
    if (
      existing.requestFingerprint !== null &&
      existing.requestFingerprint !== incomingFingerprint
    ) {
      throw idempotencyKeyConflictError();
    }

    if (
      existing.status === FileOperationStatus.COMPLETED &&
      existing.documentId !== null
    ) {
      const document = await this.prisma.document.findUnique({
        where: { id: existing.documentId },
      });
      if (!document) {
        throw new ApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          ERROR_CODES.SERVICE_UNAVAILABLE,
          'Completed upload document record is temporarily unavailable',
        );
      }
      return {
        kind: 'COMPLETED',
        operationId: existing.id,
        document: documentView(document),
      };
    }

    if (
      existing.status === FileOperationStatus.IN_PROGRESS ||
      existing.status === FileOperationStatus.CLEANUP_PENDING
    ) {
      return {
        kind: 'PENDING',
        operation: fileOperationView(existing),
      };
    }

    throw new ApiError(
      existing.errorStatus ?? HttpStatus.CONFLICT,
      existing.errorCode ?? ERROR_CODES.UPLOAD_INTERRUPTED,
      existing.errorMessage ??
        'Upload operation was interrupted before publication',
      { operationId: existing.id },
    );
  }

  private async streamAndHashStagingFile(
    stagingKey: string,
    source: UploadSource,
  ): Promise<ReceivedUploadFile> {
    const handle = await this.storage.openExclusiveStagingFile(stagingKey);
    try {
      return await source.streamToStaging(async (chunk) => {
        if (chunk.length > 0) {
          await handle.write(chunk);
        }
      }, this.config.uploadMaxBytes);
    } finally {
      await this.storage.fsyncAndClose(handle);
    }
  }

  private async persistFingerprintAndRenewLease(
    operationId: number,
    claimToken: string,
    requestFingerprint: string,
  ): Promise<void> {
    const leaseExpiresAt = this.nextLeaseExpiry();
    const updated = await this.prisma.fileOperation.updateMany({
      where: {
        id: operationId,
        status: FileOperationStatus.IN_PROGRESS,
        claimToken,
      },
      data: {
        requestFingerprint,
        leaseExpiresAt,
      },
    });
    if (updated.count === 0) {
      throw uploadInterruptedError(
        'Upload claim was superseded before validation',
      );
    }
  }

  private async publishDocumentTransaction(input: {
    readonly actor: StaffActor;
    readonly operationId: number;
    readonly claimToken: string;
    readonly studentId: number;
    readonly storageKey: string;
    readonly requestFingerprint: string;
    readonly received: ReceivedUploadFile;
    readonly mimeType: string;
    readonly byteSize: number;
  }): Promise<DocumentView> {
    const publishNow = this.clock.now();

    return this.transactions.run(
      { publishNow },
      async (tx, { publishNow: now }) => {
        const op = await lockFileOperation(tx, input.operationId);
        if (!op) {
          throw uploadInterruptedError('File operation record disappeared');
        }
        if (
          op.status === FileOperationStatus.COMPLETED &&
          op.documentId !== null
        ) {
          const existingDoc = await tx.document.findUnique({
            where: { id: op.documentId },
          });
          if (existingDoc) {
            return documentView(existingDoc);
          }
        }
        if (
          op.status !== FileOperationStatus.IN_PROGRESS ||
          op.claimToken !== input.claimToken
        ) {
          throw uploadInterruptedError(
            'Upload claim was superseded before publication',
          );
        }

        await this.students.assertActiveStudentInTx(tx, input.studentId);

        if (input.received.qualificationId !== null) {
          await tx.$queryRaw`SELECT id FROM student_qualification WHERE id = ${input.received.qualificationId} FOR SHARE`;
          await assertActiveStudentQualificationInTx(
            tx,
            input.received.qualificationId,
            input.studentId,
            'Archived qualification must be restored before attaching documents',
          );
        }

        const created = await tx.document.create({
          data: {
            studentId: input.studentId,
            qualificationId: input.received.qualificationId,
            documentType: input.received.documentType,
            originalFileName: input.received.originalFileName,
            storageKey: input.storageKey,
            mimeType: input.mimeType,
            byteSize: input.byteSize,
            uploadedAt: now,
            archivedAt: null,
            availability: DocumentAvailability.AVAILABLE,
          },
        });

        const view = documentView(created);
        await appendStaffRecordHistory(tx, input.actor, {
          recordType: 'DOCUMENT',
          recordId: created.id,
          action: 'CREATED',
          before: null,
          after: view,
          operationCorrelation: `file-operation:${input.operationId}:upload`,
        });

        await tx.fileOperation.update({
          where: { id: input.operationId },
          data: {
            status: FileOperationStatus.COMPLETED,
            documentId: created.id,
            requestFingerprint: input.requestFingerprint,
            completedAt: now,
            claimToken: null,
            executorId: null,
            leaseExpiresAt: null,
          },
        });

        return view;
      },
    );
  }

  private async probeAmbiguousPublishCommit(
    operationId: number,
  ): Promise<UploadExecutionResult | null> {
    const op = await this.prisma.fileOperation
      .findUnique({ where: { id: operationId } })
      .catch(() => null);
    if (
      op?.status === FileOperationStatus.COMPLETED &&
      op.documentId !== null
    ) {
      const document = await this.prisma.document
        .findUnique({ where: { id: op.documentId } })
        .catch(() => null);
      if (document) {
        return {
          kind: 'COMPLETED',
          operationId: op.id,
          document: documentView(document),
        };
      }
    }
    return null;
  }

  private async cleanupFailedUpload(
    operationId: number,
    expectedClaimToken: string,
    stagingKey: string,
    storageKey: string,
    failure: SanitizedFailure,
  ): Promise<void> {
    const cleanupToken = randomBytes(32).toString('hex');
    const leaseExpiresAt = this.nextLeaseExpiry();

    const claimed = await this.transactions
      .run(undefined, async (tx) => {
        const op = await lockFileOperation(tx, operationId);
        if (
          !op ||
          op.status !== FileOperationStatus.IN_PROGRESS ||
          op.claimToken !== expectedClaimToken
        ) {
          return false;
        }
        await tx.fileOperation.update({
          where: { id: op.id },
          data: {
            status: FileOperationStatus.CLEANUP_PENDING,
            executorId: this.executorId,
            claimToken: cleanupToken,
            leaseExpiresAt,
            errorStatus: failure.status,
            errorCode: failure.code,
            errorMessage: failure.message,
          },
        });
        return true;
      })
      .catch(() => false);

    if (!claimed) {
      return;
    }

    await this.finalizeClaimedCleanup({
      operationId,
      cleanupToken,
      stagingKey,
      storageKey,
      fallbackFailure: failure,
    });
  }

  private async executeReconciliation(
    includeForeignActive: boolean,
  ): Promise<void> {
    const now = this.clock.now();
    const candidates = await this.prisma.fileOperation.findMany({
      where: {
        kind: FileOperationKind.UPLOAD,
        status: {
          in: [
            FileOperationStatus.IN_PROGRESS,
            FileOperationStatus.CLEANUP_PENDING,
          ],
        },
      },
      orderBy: { id: 'asc' },
    });

    for (const candidate of candidates) {
      if (this.inFlightIds.has(candidate.id)) {
        continue;
      }
      if (!this.isOperationReclaimable(candidate, now, includeForeignActive)) {
        continue;
      }

      const recoveryToken = randomBytes(32).toString('hex');
      const claimed = await this.claimOperationForCleanup(
        candidate.id,
        recoveryToken,
        includeForeignActive,
      );
      if (!claimed) {
        continue;
      }

      await this.finalizeClaimedCleanup({
        operationId: claimed.id,
        cleanupToken: recoveryToken,
        stagingKey: claimed.stagingKey,
        storageKey: claimed.storageKey,
        fallbackFailure: {
          status: claimed.errorStatus ?? HttpStatus.CONFLICT,
          code: claimed.errorCode ?? ERROR_CODES.UPLOAD_INTERRUPTED,
          message:
            claimed.errorMessage ??
            'Upload operation was interrupted before publication',
        },
      });
    }
  }

  private async claimOperationForCleanup(
    operationId: number,
    recoveryToken: string,
    includeForeignActive: boolean,
  ): Promise<FileOperation | null> {
    const now = this.clock.now();
    const leaseExpiresAt = this.nextLeaseExpiry(now);

    return this.transactions.run(undefined, async (tx) => {
      if (this.inFlightIds.has(operationId)) {
        return null;
      }
      const op = await lockFileOperation(tx, operationId);
      if (
        !op ||
        op.kind !== FileOperationKind.UPLOAD ||
        (op.status !== FileOperationStatus.IN_PROGRESS &&
          op.status !== FileOperationStatus.CLEANUP_PENDING)
      ) {
        return null;
      }
      if (!this.isOperationReclaimable(op, now, includeForeignActive)) {
        return null;
      }

      return tx.fileOperation.update({
        where: { id: op.id },
        data: {
          status: FileOperationStatus.CLEANUP_PENDING,
          executorId: this.executorId,
          claimToken: recoveryToken,
          leaseExpiresAt,
          ...(op.errorCode === null
            ? {
                errorStatus: HttpStatus.CONFLICT,
                errorCode: ERROR_CODES.UPLOAD_INTERRUPTED,
                errorMessage:
                  'Upload operation was interrupted before publication',
              }
            : {}),
        },
      });
    });
  }

  private async finalizeClaimedCleanup(input: {
    readonly operationId: number;
    readonly cleanupToken: string;
    readonly stagingKey: string | null;
    readonly storageKey: string;
    readonly fallbackFailure: SanitizedFailure;
  }): Promise<void> {
    await this.triggerCutPoint(
      'AFTER_CLEANUP_CLAIM_BEFORE_UNLINK',
      input.operationId,
    );

    if (input.stagingKey !== null) {
      await this.storage
        .removeArtifactIfExists('staging', input.stagingKey)
        .catch((err: unknown) => {
          const name = err instanceof Error ? err.name : 'UnknownError';
          this.logger.warn(`Failed to remove staging artifact (${name})`);
          throw err;
        });
    }

    const referencedDocument = await this.prisma.document.findUnique({
      where: { storageKey: input.storageKey },
      select: { id: true },
    });
    if (referencedDocument === null) {
      await this.storage
        .removeArtifactIfExists('objects', input.storageKey)
        .catch((err: unknown) => {
          const name = err instanceof Error ? err.name : 'UnknownError';
          this.logger.warn(`Failed to remove unreferenced artifact (${name})`);
          throw err;
        });
    }

    const completedAt = this.clock.now();
    await this.transactions.run(undefined, async (tx) => {
      const op = await lockFileOperation(tx, input.operationId);
      if (
        !op ||
        op.status !== FileOperationStatus.CLEANUP_PENDING ||
        op.claimToken !== input.cleanupToken
      ) {
        return;
      }
      await tx.fileOperation.update({
        where: { id: op.id },
        data: {
          status: FileOperationStatus.FAILED,
          completedAt,
          claimToken: null,
          executorId: null,
          leaseExpiresAt: null,
          errorStatus: op.errorStatus ?? input.fallbackFailure.status,
          errorCode: op.errorCode ?? input.fallbackFailure.code,
          errorMessage: op.errorMessage ?? input.fallbackFailure.message,
        },
      });
    });
  }

  private nextLeaseExpiry(now = this.clock.now()): Date {
    return new Date(
      now.getTime() + this.config.fileOperationLeaseSeconds * 1000,
    );
  }

  private isOperationReclaimable(
    op: Pick<FileOperation, 'leaseExpiresAt' | 'executorId'>,
    now: Date,
    includeForeignActive: boolean,
  ): boolean {
    const isExpired =
      op.leaseExpiresAt === null ||
      op.leaseExpiresAt.getTime() <= now.getTime();
    const isForeignOnStartup =
      includeForeignActive && op.executorId !== this.executorId;
    return isExpired || isForeignOnStartup;
  }

  private computeReceivedFingerprint(
    studentId: number,
    received: ReceivedUploadFile,
  ): string {
    return computeUploadRequestFingerprint({
      studentId,
      documentType: received.documentType,
      qualificationId: received.qualificationId,
      originalFileName: received.originalFileName,
      byteSize: received.byteSize,
      contentSha256: received.contentSha256,
    });
  }

  private async triggerCutPoint(
    cutPoint: FileOperationFaultCutPoint,
    operationId: number,
  ): Promise<void> {
    await this.faultHook.onCutPoint(cutPoint, { operationId });
  }
}

async function lockFileOperation(
  tx: Prisma.TransactionClient,
  id: number,
): Promise<FileOperation | null> {
  await tx.$queryRaw`SELECT id FROM file_operation WHERE id = ${id} FOR UPDATE`;
  return tx.fileOperation.findUnique({ where: { id } });
}

function sanitizeOperationFailure(error: unknown): SanitizedFailure {
  if (error instanceof ApiError) {
    const message = error.message.trim().slice(0, 300) || 'Upload failed';
    return {
      status: error.getStatus(),
      code: error.code,
      message,
    };
  }
  return {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: ERROR_CODES.SERVICE_UNAVAILABLE,
    message: 'Upload failed before completion',
  };
}
