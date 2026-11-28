import {
  DocumentAvailability,
  DocumentType,
  FileOperationKind,
  FileOperationStatus,
} from '../generated/prisma/client';
import { documentView, fileOperationView } from './documents.views';

describe('documents views', () => {
  it('excludes private storageKey and unexpected fields from documentView', () => {
    const now = new Date('2026-11-28T10:00:00.000Z');
    const row = {
      id: 7,
      studentId: 12,
      qualificationId: 3,
      documentType: DocumentType.BACHELOR_CERTIFICATE,
      originalFileName: 'degree.pdf',
      storageKey: 'f'.repeat(64),
      mimeType: 'application/pdf',
      byteSize: 4096,
      uploadedAt: now,
      archivedAt: null,
      availability: DocumentAvailability.AVAILABLE,
      deletedAt: null,
      deletedByStaffUserId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      extraSecretField: '/var/lib/private/storage/secret',
    };

    const view = documentView(row);
    expect(view).toEqual({
      id: 7,
      studentId: 12,
      qualificationId: 3,
      documentType: DocumentType.BACHELOR_CERTIFICATE,
      originalFileName: 'degree.pdf',
      mimeType: 'application/pdf',
      byteSize: 4096,
      uploadedAt: '2026-11-28T10:00:00.000Z',
      archivedAt: null,
      availability: DocumentAvailability.AVAILABLE,
      deletedAt: null,
      deletedByStaffUserId: null,
      version: 1,
      createdAt: '2026-11-28T10:00:00.000Z',
      updatedAt: '2026-11-28T10:00:00.000Z',
    });
    expect(view).not.toHaveProperty('storageKey');
    expect(view).not.toHaveProperty('extraSecretField');
  });

  it('excludes private keys, tokens, fingerprints, and executor internals from fileOperationView', () => {
    const now = new Date('2026-11-28T10:00:00.000Z');
    const row = {
      id: 99,
      kind: FileOperationKind.UPLOAD,
      status: FileOperationStatus.FAILED,
      requestedByStaffUserId: 5,
      studentId: 12,
      documentId: null,
      idempotencyKey: 'idem-1',
      requestFingerprint: 'e'.repeat(64),
      stagingKey: 'a'.repeat(64),
      storageKey: 'b'.repeat(64),
      executorId: 'worker-uuid',
      claimToken: 'c'.repeat(64),
      leaseExpiresAt: now,
      errorStatus: 400,
      errorCode: 'UNSUPPORTED_FILE_FORMAT',
      errorMessage: 'Unsupported format',
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    };

    const view = fileOperationView(row);
    expect(view).toEqual({
      id: 99,
      kind: FileOperationKind.UPLOAD,
      status: FileOperationStatus.FAILED,
      studentId: 12,
      documentId: null,
      failureCode: 'UNSUPPORTED_FILE_FORMAT',
      failureMessage: 'Unsupported format',
      createdAt: '2026-11-28T10:00:00.000Z',
      updatedAt: '2026-11-28T10:00:00.000Z',
      completedAt: '2026-11-28T10:00:00.000Z',
    });
    for (const secretField of [
      'stagingKey',
      'storageKey',
      'claimToken',
      'executorId',
      'requestFingerprint',
      'idempotencyKey',
      'errorStatus',
      'leaseExpiresAt',
      'requestedByStaffUserId',
    ]) {
      expect(view).not.toHaveProperty(secretField);
    }
  });
});
