import { Module } from '@nestjs/common';
import { ChangeHistoryModule } from '../change-history/change-history.module';
import { QualificationMutationGuardRegistry } from './qualification-mutation-guard';
import {
  QualificationsController,
  StudentQualificationsController,
} from './qualifications.controller';
import { QualificationsService } from './qualifications.service';
import { StudentArchiveGuardRegistry } from './student-archive-guard';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

@Module({
  imports: [ChangeHistoryModule],
  controllers: [
    StudentsController,
    StudentQualificationsController,
    QualificationsController,
  ],
  providers: [
    StudentArchiveGuardRegistry,
    StudentsService,
    QualificationMutationGuardRegistry,
    QualificationsService,
  ],
  exports: [
    StudentArchiveGuardRegistry,
    StudentsService,
    QualificationMutationGuardRegistry,
    QualificationsService,
  ],
})
export class StudentsModule {}
