import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.module';
import type { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoginThrottler } from './login-throttler';
import { PreLoginCsrfStore } from './pre-login-csrf';
import { cleanupExpiredSessions } from './session-cleanup';
import { STAFF_AUTH_CLOCK, type Clock } from './staff-auth.service';

@Injectable()
export class SessionCleanupScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionCleanupScheduler.name);
  private readonly clock: Clock;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly preLoginCsrf: PreLoginCsrfStore,
    private readonly throttler: LoginThrottler,
    @Optional() @Inject(STAFF_AUTH_CLOCK) clock?: Clock,
  ) {
    this.clock = clock ?? { now: () => new Date() };
  }

  onModuleInit(): void {
    this.stopped = false;
    const intervalMs = this.config.sessionCleanupIntervalMinutes * 60_000;
    this.timer = setInterval(() => {
      void this.runSweep();
    }, intervalMs);
    this.timer.unref();
  }

  runSweep(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    if (this.stopped) {
      return Promise.resolve();
    }
    this.inFlight = this.executeSweep().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  private async executeSweep(): Promise<void> {
    try {
      const now = this.clock.now();
      await cleanupExpiredSessions(
        this.prisma,
        this.config.sessionIdleTimeoutMinutes,
        now,
      );
      this.preLoginCsrf.sweep(now);
      this.throttler.sweep(now);
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : 'UnknownError';
      this.logger.error(`Session cleanup sweep failed (${name})`);
    }
  }
}
