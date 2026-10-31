import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.module';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
    this.logger.log('Connected to the database');
  }

  /**
   * Nest closes the HTTP server (draining in-flight requests) before it calls
   * application-shutdown hooks, but runs module-destroy hooks first. Disconnect
   * here so requests that are still running keep a working database.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
