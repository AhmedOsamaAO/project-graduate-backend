import { Module } from '@nestjs/common';
import { ChangeHistoryService } from './change-history.service';

@Module({
  providers: [ChangeHistoryService],
  exports: [ChangeHistoryService],
})
export class ChangeHistoryModule {}
