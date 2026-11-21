import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { LOGIN_THROTTLER_OPTIONS, LoginThrottler } from './login-throttler';
import { PreLoginCsrfStore } from './pre-login-csrf';
import { SessionCleanupScheduler } from './session-cleanup.scheduler';
import { StaffAccessGuard } from './staff-access.guard';
import { STAFF_AUTH_CLOCK, StaffAuthService } from './staff-auth.service';

@Module({
  controllers: [AuthController],
  providers: [
    { provide: STAFF_AUTH_CLOCK, useValue: { now: () => new Date() } },
    { provide: LOGIN_THROTTLER_OPTIONS, useValue: {} },
    PreLoginCsrfStore,
    LoginThrottler,
    StaffAuthService,
    SessionCleanupScheduler,
    { provide: APP_GUARD, useClass: StaffAccessGuard },
  ],
  exports: [
    StaffAuthService,
    PreLoginCsrfStore,
    LoginThrottler,
    SessionCleanupScheduler,
  ],
})
export class StaffAccessModule {}
