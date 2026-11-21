import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.module';
import {
  clearCookieOptions,
  csrfCookieName,
  parseCookieValue,
  sessionCookieName,
} from './cookies';
import type { StaffAuthenticatedRequest } from './current-session.decorator';
import { PreLoginCsrfStore } from './pre-login-csrf';
import { IS_PUBLIC_KEY } from './public.decorator';
import {
  STAFF_AUTH_CLOCK,
  StaffAuthService,
  type AuthenticatedSession,
  type Clock,
} from './staff-auth.service';
import { timingSafeTokenEqual } from './tokens';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class StaffAccessGuard implements CanActivate {
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly clock: Clock;

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly staffAuth: StaffAuthService,
    private readonly preLoginCsrf: PreLoginCsrfStore,
    @Optional() @Inject(STAFF_AUTH_CLOCK) clock?: Clock,
  ) {
    this.allowedOrigins = new Set(config.frontendOrigins);
    this.clock = clock ?? { now: () => new Date() };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<StaffAuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    const isStateChanging = !SAFE_METHODS.has(request.method.toUpperCase());
    const origin = extractSingleHeader(request.headers.origin, 512);

    if (
      isStateChanging &&
      origin !== undefined &&
      !this.allowedOrigins.has(origin)
    ) {
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        ERROR_CODES.ORIGIN_NOT_ALLOWED,
        'Origin is not allowed',
      );
    }

    if (isPublic) {
      if (!isStateChanging || this.config.csrfMode !== 'synchronizer') {
        return true;
      }

      this.assertAllowedOrigin(origin);
      const csrfHeader = extractSingleHeader(
        request.headers['x-csrf-token'],
        512,
      );
      const preLoginCookie = parseCookieValue(
        request.headers.cookie,
        csrfCookieName(this.config),
      );

      if (
        preLoginCookie !== undefined &&
        this.preLoginCsrf.verify(preLoginCookie, csrfHeader, this.clock.now())
      ) {
        request.preLoginCsrfCookie = preLoginCookie;
        return true;
      }

      const sessionRaw = parseCookieValue(
        request.headers.cookie,
        sessionCookieName(this.config),
      );
      const activeSession = await this.staffAuth.resolveSession(sessionRaw, {
        touch: false,
      });
      if (
        activeSession &&
        csrfHeader !== undefined &&
        timingSafeTokenEqual(activeSession.csrfToken, csrfHeader)
      ) {
        return true;
      }

      throw new ApiError(
        HttpStatus.FORBIDDEN,
        ERROR_CODES.CSRF_INVALID,
        'Invalid CSRF token',
      );
    }

    const sessionRaw = parseCookieValue(
      request.headers.cookie,
      sessionCookieName(this.config),
    );

    if (!isStateChanging) {
      request.staffSession = await this.requireSession(
        sessionRaw,
        response,
        true,
      );
      return true;
    }

    const session = await this.requireSession(sessionRaw, response, false);

    if (this.config.csrfMode === 'synchronizer') {
      this.assertAllowedOrigin(origin);
      const csrfHeader = extractSingleHeader(
        request.headers['x-csrf-token'],
        512,
      );
      if (!csrfHeader || !timingSafeTokenEqual(session.csrfToken, csrfHeader)) {
        throw new ApiError(
          HttpStatus.FORBIDDEN,
          ERROR_CODES.CSRF_INVALID,
          'Invalid CSRF token',
        );
      }
    }

    request.staffSession = await this.requireSession(
      sessionRaw,
      response,
      true,
    );
    return true;
  }

  private async requireSession(
    sessionRaw: string | undefined,
    response: Response,
    touch: boolean,
  ): Promise<AuthenticatedSession> {
    const session = await this.staffAuth.resolveSession(sessionRaw, { touch });
    if (!session) {
      if (sessionRaw !== undefined) {
        response.clearCookie(
          sessionCookieName(this.config),
          clearCookieOptions(this.config),
        );
      }
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        ERROR_CODES.UNAUTHENTICATED,
        'Authentication required',
      );
    }
    return session;
  }

  private assertAllowedOrigin(origin: string | undefined): void {
    if (origin === undefined || !this.allowedOrigins.has(origin)) {
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        ERROR_CODES.ORIGIN_NOT_ALLOWED,
        'Origin is not allowed',
      );
    }
  }
}

function extractSingleHeader(
  value: string | string[] | undefined,
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  if (value.length > maxLength) {
    return undefined;
  }
  return value;
}
