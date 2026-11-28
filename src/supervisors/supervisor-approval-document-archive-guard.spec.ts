import { ERROR_CODES } from '../common/errors/error-codes';
import {
  DocumentType,
  ExternalApprovalStatus,
  SupervisorAffiliation,
  type Prisma,
} from '../generated/prisma/client';
import { type DocumentArchiveContext } from '../documents/document-archive-guard';
import { createSupervisorApprovalDocumentArchiveGuard } from './supervisor-approval-document-archive-guard';

describe('SupervisorApprovalDocumentArchiveGuard', () => {
  const guard = createSupervisorApprovalDocumentArchiveGuard();
  const supervisorDocContext: DocumentArchiveContext = {
    documentId: 20,
    studentId: null,
    supervisorId: 7,
    documentType: DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT,
    qualificationId: null,
  };

  it('ignores student-owned documents without querying supervisor', async () => {
    const tx = {
      supervisor: {
        findUnique: () =>
          Promise.reject(
            new Error('should not inspect supervisor for student doc'),
          ),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      guard.assertCanArchive(tx, {
        documentId: 10,
        studentId: 3,
        supervisorId: null,
        documentType: DocumentType.PERSONAL_PHOTO,
        qualificationId: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('blocks archiving the last unarchived supporting document of an approved external supervisor', async () => {
    const tx = {
      supervisor: {
        findUnique: () =>
          Promise.resolve({
            affiliation: SupervisorAffiliation.EXTERNAL,
            externalApprovalStatus: ExternalApprovalStatus.APPROVED,
          }),
      },
      document: {
        count: () => Promise.resolve(0),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      guard.assertCanArchive(tx, supervisorDocContext),
    ).rejects.toMatchObject({
      status: 409,
      code: ERROR_CODES.SUPERVISOR_APPROVAL_REQUIRES_DOCUMENT,
    });
  });

  it('allows archiving when another unarchived available supporting document exists or supervisor is not approved', async () => {
    const anotherDocTx = {
      supervisor: {
        findUnique: () =>
          Promise.resolve({
            affiliation: SupervisorAffiliation.EXTERNAL,
            externalApprovalStatus: ExternalApprovalStatus.APPROVED,
          }),
      },
      document: {
        count: () => Promise.resolve(1),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      guard.assertCanArchive(anotherDocTx, supervisorDocContext),
    ).resolves.toBeUndefined();

    const pendingTx = {
      supervisor: {
        findUnique: () =>
          Promise.resolve({
            affiliation: SupervisorAffiliation.EXTERNAL,
            externalApprovalStatus: ExternalApprovalStatus.PENDING,
          }),
      },
      document: {
        count: () => Promise.reject(new Error('should not count for PENDING')),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      guard.assertCanArchive(pendingTx, supervisorDocContext),
    ).resolves.toBeUndefined();
  });
});
