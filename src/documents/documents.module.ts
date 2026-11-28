import { Module } from '@nestjs/common';
import { ChangeHistoryModule } from '../change-history/change-history.module';
import { StudentsModule } from '../students/students.module';
import {
  DocumentArchiveGuardRegistry,
  SelectedPhotoDocumentArchiveGuard,
} from './document-archive-guard';
import {
  DocumentsController,
  FileOperationsController,
  StudentDocumentsController,
} from './documents.controller';
import { DocumentsService } from './documents.service';
import {
  DOCUMENTS_CLOCK,
  FILE_OPERATION_FAULT_HOOK,
  FileOperationExecutor,
} from './file-operation-executor';
import { PrivateFileStorage } from './private-file-storage';

@Module({
  imports: [ChangeHistoryModule, StudentsModule],
  controllers: [
    StudentDocumentsController,
    DocumentsController,
    FileOperationsController,
  ],
  providers: [
    { provide: DOCUMENTS_CLOCK, useValue: { now: () => new Date() } },
    {
      provide: FILE_OPERATION_FAULT_HOOK,
      useValue: { onCutPoint: () => undefined },
    },
    PrivateFileStorage,
    DocumentArchiveGuardRegistry,
    SelectedPhotoDocumentArchiveGuard,
    FileOperationExecutor,
    DocumentsService,
  ],
  exports: [
    PrivateFileStorage,
    DocumentArchiveGuardRegistry,
    FileOperationExecutor,
    DocumentsService,
  ],
})
export class DocumentsModule {}
