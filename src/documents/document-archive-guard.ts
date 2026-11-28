import {
  HttpStatus,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { DocumentType, Prisma } from '../generated/prisma/client';

export interface DocumentArchiveContext {
  readonly documentId: number;
  readonly studentId: number | null;
  readonly supervisorId: number | null;
  readonly documentType: DocumentType;
  readonly qualificationId: number | null;
}

/**
 * Transaction-scoped guard contract registered by dependent modules
 * (selected photo, external supervisor approval, pending permanent deletion)
 * to block archiving a document without creating cyclic Nest provider dependencies.
 */
export interface DocumentArchiveGuard {
  readonly name: string;
  assertCanArchive(
    tx: Prisma.TransactionClient,
    context: DocumentArchiveContext,
  ): Promise<void>;
}

@Injectable()
export class DocumentArchiveGuardRegistry {
  private readonly guards = new Map<string, DocumentArchiveGuard>();

  register(guard: DocumentArchiveGuard): () => void {
    if (this.guards.has(guard.name)) {
      throw new Error(
        `Document archive guard "${guard.name}" is already registered`,
      );
    }

    this.guards.set(guard.name, guard);
    return () => {
      if (this.guards.get(guard.name) === guard) {
        this.guards.delete(guard.name);
      }
    };
  }

  async assertCanArchive(
    tx: Prisma.TransactionClient,
    context: DocumentArchiveContext,
  ): Promise<void> {
    for (const guard of this.guards.values()) {
      await guard.assertCanArchive(tx, context);
    }
  }
}

export function createSelectedPhotoDocumentArchiveGuard(): DocumentArchiveGuard {
  return {
    name: 'selected-photo',
    async assertCanArchive(tx, context): Promise<void> {
      if (context.studentId === null) {
        return;
      }
      const student = await tx.student.findUnique({
        where: { id: context.studentId },
        select: { selectedPhotoDocumentId: true },
      });
      if (student?.selectedPhotoDocumentId === context.documentId) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          ERROR_CODES.DOCUMENT_SELECTED_AS_PHOTO,
          'Clear or replace the selected personal photo before archiving this document',
        );
      }
    },
  };
}

@Injectable()
export class SelectedPhotoDocumentArchiveGuard
  implements OnModuleInit, OnModuleDestroy
{
  private unregister?: () => void;

  constructor(private readonly registry: DocumentArchiveGuardRegistry) {}

  onModuleInit(): void {
    this.unregister = this.registry.register(
      createSelectedPhotoDocumentArchiveGuard(),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = undefined;
  }
}
