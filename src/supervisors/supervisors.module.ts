import { Module } from '@nestjs/common';
import { ChangeHistoryModule } from '../change-history/change-history.module';
import { DocumentsModule } from '../documents/documents.module';
import { SupervisorApprovalDocumentArchiveGuard } from './supervisor-approval-document-archive-guard';
import { SupervisorCorrectionGuardRegistry } from './supervisor-correction-guard';
import { SupervisorsController } from './supervisors.controller';
import { SUPERVISORS_CLOCK, SupervisorsService } from './supervisors.service';

@Module({
  imports: [ChangeHistoryModule, DocumentsModule],
  controllers: [SupervisorsController],
  providers: [
    { provide: SUPERVISORS_CLOCK, useValue: { now: () => new Date() } },
    SupervisorCorrectionGuardRegistry,
    SupervisorApprovalDocumentArchiveGuard,
    SupervisorsService,
  ],
  exports: [SupervisorCorrectionGuardRegistry, SupervisorsService],
})
export class SupervisorsModule {}
