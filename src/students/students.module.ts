import { Module } from '@nestjs/common';
import { ChangeHistoryModule } from '../change-history/change-history.module';
import { StudentArchiveGuardRegistry } from './student-archive-guard';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

@Module({
  imports: [ChangeHistoryModule],
  controllers: [StudentsController],
  providers: [StudentArchiveGuardRegistry, StudentsService],
  exports: [StudentArchiveGuardRegistry, StudentsService],
})
export class StudentsModule {}
