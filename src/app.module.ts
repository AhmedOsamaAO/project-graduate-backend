import { DynamicModule, Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChangeHistoryModule } from './change-history/change-history.module';
import { AppConfigModule } from './config/app-config.module';
import type { AppConfig } from './config/app-config';
import { PrismaModule } from './prisma/prisma.module';
import { ReferenceDataModule } from './reference-data/reference-data.module';
import { StaffAccessModule } from './staff-access/staff-access.module';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.register(config),
        PrismaModule,
        ChangeHistoryModule,
        StaffAccessModule,
        ReferenceDataModule,
      ],
      controllers: [AppController],
      providers: [AppService],
    };
  }
}
