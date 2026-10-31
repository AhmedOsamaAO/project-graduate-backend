import { DynamicModule, Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppConfigModule } from './config/app-config.module';
import type { AppConfig } from './config/app-config';
import { PrismaModule } from './prisma/prisma.module';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [AppConfigModule.register(config), PrismaModule],
      controllers: [AppController],
      providers: [AppService],
    };
  }
}
