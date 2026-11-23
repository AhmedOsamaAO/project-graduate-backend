import { Module } from '@nestjs/common';
import { ChangeHistoryModule } from '../change-history/change-history.module';
import { DepartmentsController } from './departments.controller';
import { FacultiesController } from './faculties.controller';
import { InstitutionsController } from './institutions.controller';
import { ReferenceDataService } from './reference-data.service';

@Module({
  imports: [ChangeHistoryModule],
  controllers: [
    InstitutionsController,
    FacultiesController,
    DepartmentsController,
  ],
  providers: [ReferenceDataService],
  exports: [ReferenceDataService],
})
export class ReferenceDataModule {}
