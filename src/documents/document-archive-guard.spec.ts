import { ERROR_CODES } from '../common/errors/error-codes';
import { DocumentType, type Prisma } from '../generated/prisma/client';
import {
  DocumentArchiveGuardRegistry,
  createSelectedPhotoDocumentArchiveGuard,
  type DocumentArchiveContext,
} from './document-archive-guard';

describe('DocumentArchiveGuardRegistry and SelectedPhotoDocumentArchiveGuard', () => {
  const sampleContext: DocumentArchiveContext = {
    documentId: 42,
    studentId: 7,
    documentType: DocumentType.PERSONAL_PHOTO,
    qualificationId: null,
  };

  it('registers, invokes, and unregisters guards while rejecting duplicate names', async () => {
    const registry = new DocumentArchiveGuardRegistry();
    const calls: number[] = [];

    const unregister = registry.register({
      name: 'custom-guard',
      assertCanArchive: (_tx, ctx) => {
        calls.push(ctx.documentId);
        return Promise.resolve();
      },
    });

    expect(() =>
      registry.register({
        name: 'custom-guard',
        assertCanArchive: () => Promise.resolve(),
      }),
    ).toThrow(/already registered/);

    await registry.assertCanArchive(
      {} as Prisma.TransactionClient,
      sampleContext,
    );
    expect(calls).toEqual([42]);

    unregister();
    // Idempotent second unregister should not remove a newly registered guard with the same name
    registry.register({
      name: 'custom-guard',
      assertCanArchive: () => Promise.reject(new Error('should stay')),
    });
    unregister();
    await expect(
      registry.assertCanArchive({} as Prisma.TransactionClient, sampleContext),
    ).rejects.toThrow('should stay');
  });

  it('blocks archiving when the document is the student selected personal photo', async () => {
    const guard = createSelectedPhotoDocumentArchiveGuard();

    const selectedTx = {
      student: {
        findUnique: () => Promise.resolve({ selectedPhotoDocumentId: 42 }),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      guard.assertCanArchive(selectedTx, sampleContext),
    ).rejects.toMatchObject({
      status: 409,
      code: ERROR_CODES.DOCUMENT_SELECTED_AS_PHOTO,
    });

    const otherPhotoTx = {
      student: {
        findUnique: () => Promise.resolve({ selectedPhotoDocumentId: 99 }),
      },
    } as unknown as Prisma.TransactionClient;
    await expect(
      guard.assertCanArchive(otherPhotoTx, sampleContext),
    ).resolves.toBeUndefined();

    const clearedTx = {
      student: {
        findUnique: () => Promise.resolve({ selectedPhotoDocumentId: null }),
      },
    } as unknown as Prisma.TransactionClient;
    await expect(
      guard.assertCanArchive(clearedTx, sampleContext),
    ).resolves.toBeUndefined();
  });
});
