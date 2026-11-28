import {
  HttpStatus,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  DocumentArchiveGuardRegistry,
  type DocumentArchiveGuard,
} from '../documents/document-archive-guard';
import {
  DocumentAvailability,
  ExternalApprovalStatus,
  SupervisorAffiliation,
} from '../generated/prisma/client';

export function createSupervisorApprovalDocumentArchiveGuard(): DocumentArchiveGuard {
  return {
    name: 'supervisor-approval-evidence',
    async assertCanArchive(tx, context): Promise<void> {
      if (context.supervisorId === null) {
        return;
      }

      const supervisor = await tx.supervisor.findUnique({
        where: { id: context.supervisorId },
        select: { affiliation: true, externalApprovalStatus: true },
      });
      if (
        supervisor?.affiliation !== SupervisorAffiliation.EXTERNAL ||
        supervisor.externalApprovalStatus !== ExternalApprovalStatus.APPROVED
      ) {
        return;
      }

      const remainingCount = await tx.document.count({
        where: {
          supervisorId: context.supervisorId,
          id: { not: context.documentId },
          archivedAt: null,
          availability: DocumentAvailability.AVAILABLE,
        },
      });
      if (remainingCount === 0) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          ERROR_CODES.SUPERVISOR_APPROVAL_REQUIRES_DOCUMENT,
          'Upload another supporting document or change external approval status before archiving the last supporting document',
        );
      }
    },
  };
}

@Injectable()
export class SupervisorApprovalDocumentArchiveGuard
  implements OnModuleInit, OnModuleDestroy
{
  private unregister?: () => void;

  constructor(private readonly registry: DocumentArchiveGuardRegistry) {}

  onModuleInit(): void {
    this.unregister = this.registry.register(
      createSupervisorApprovalDocumentArchiveGuard(),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = undefined;
  }
}
