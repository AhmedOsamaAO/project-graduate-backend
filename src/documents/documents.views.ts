import type { Document, FileOperation } from '../generated/prisma/client';
import type { DocumentArchiveContext } from './document-archive-guard';

export type DocumentViewSource = Pick<
  Document,
  | 'id'
  | 'studentId'
  | 'supervisorId'
  | 'qualificationId'
  | 'documentType'
  | 'description'
  | 'originalFileName'
  | 'mimeType'
  | 'byteSize'
  | 'uploadedAt'
  | 'archivedAt'
  | 'availability'
  | 'deletedAt'
  | 'deletedByStaffUserId'
  | 'version'
  | 'createdAt'
  | 'updatedAt'
>;

/** Explicit allowlist excluding private storageKey for responses and change history. */
export function documentView(row: DocumentViewSource) {
  return {
    id: row.id,
    studentId: row.studentId,
    supervisorId: row.supervisorId,
    qualificationId: row.qualificationId,
    documentType: row.documentType,
    description: row.description,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    uploadedAt: row.uploadedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    availability: row.availability,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    deletedByStaffUserId: row.deletedByStaffUserId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type DocumentView = ReturnType<typeof documentView>;

export type FileOperationViewSource = Pick<
  FileOperation,
  | 'id'
  | 'kind'
  | 'status'
  | 'studentId'
  | 'supervisorId'
  | 'documentId'
  | 'errorCode'
  | 'errorMessage'
  | 'createdAt'
  | 'updatedAt'
  | 'completedAt'
>;

/** Sanitized operation status excluding storage keys, staging keys, claims, and fingerprints. */
export function fileOperationView(row: FileOperationViewSource) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    studentId: row.studentId,
    supervisorId: row.supervisorId,
    documentId: row.documentId,
    failureCode: row.errorCode,
    failureMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export type FileOperationView = ReturnType<typeof fileOperationView>;

export function toDocumentArchiveContext(
  row: Pick<
    Document,
    'id' | 'studentId' | 'supervisorId' | 'documentType' | 'qualificationId'
  >,
): DocumentArchiveContext {
  return {
    documentId: row.id,
    studentId: row.studentId,
    supervisorId: row.supervisorId,
    documentType: row.documentType,
    qualificationId: row.qualificationId,
  };
}
