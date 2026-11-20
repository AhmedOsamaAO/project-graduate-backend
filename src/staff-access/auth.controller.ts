import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiExtraModels,
  ApiHeader,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { StaffAccountView } from '../change-history/change-history';
import { ApiError } from '../common/errors/api-error';
import {
  ApiCommonErrorResponses,
  ApiDataResponse,
} from '../common/http/api-response.decorators';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.module';
import {
  clearCookieOptions,
  csrfCookieName,
  csrfCookieOptions,
  parseCookieValue,
  sessionCookieName,
  sessionCookieOptions,
} from './cookies';
import {
  CurrentSession,
  type StaffAuthenticatedRequest,
} from './current-session.decorator';
import {
  AuthSessionResponseDto,
  ChangePasswordDto,
  CsrfResponseDto,
  LoginDto,
  StaffAccountDto,
} from './dto/auth.dto';
import { PreLoginCsrfStore } from './pre-login-csrf';
import { Public } from './public.decorator';
import {
  STAFF_AUTH_CLOCK,
  StaffAuthService,
  type AuthenticatedSession,
  type Clock,
} from './staff-auth.service';

@ApiTags('auth')
@ApiCommonErrorResponses()
@ApiExtraModels(StaffAccountDto, CsrfResponseDto, AuthSessionResponseDto)
@Controller('auth')
export class AuthController {
  private readonly clock: Clock;

  constructor(
    private readonly staffAuth: StaffAuthService,
    private readonly preLoginCsrf: PreLoginCsrfStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(STAFF_AUTH_CLOCK) clock?: Clock,
  ) {
    this.clock = clock ?? { now: () => new Date() };
  }

  @Public()
  @Get('csrf')
  @ApiOperation({
    summary:
      'Bootstrap a pre-login CSRF token or fetch the active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(CsrfResponseDto) },
    'CSRF token for state-changing requests',
  )
  async getCsrf(
    @Req() request: StaffAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly csrfToken: string }> {
    response.setHeader('Cache-Control', 'no-store');

    const sessionRaw = parseCookieValue(
      request.headers.cookie,
      sessionCookieName(this.config),
    );
    if (sessionRaw) {
      const session = await this.staffAuth.resolveSession(sessionRaw, {
        touch: false,
      });
      if (session) {
        return { csrfToken: session.csrfToken };
      }
    }

    const issued = this.preLoginCsrf.issue(this.clock.now());
    response.cookie(
      csrfCookieName(this.config),
      issued.cookieValue,
      csrfCookieOptions(this.config),
    );
    return { csrfToken: issued.csrfToken };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate a staff user and issue a session' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'CSRF token obtained from GET /api/v1/auth/csrf',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(AuthSessionResponseDto) },
    'Authenticated staff user and session CSRF token',
  )
  async login(
    @Body() body: LoginDto,
    @Req() request: StaffAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly user: StaffAccountView; readonly csrfToken: string }> {
    response.setHeader('Cache-Control', 'no-store');

    const clientIp = request.ip || request.socket?.remoteAddress || 'unknown';
    const previousSessionRaw = parseCookieValue(
      request.headers.cookie,
      sessionCookieName(this.config),
    );
    const result = await this.staffAuth.login({
      username: body.username,
      password: body.password,
      clientIp,
      previousSessionRaw,
    });

    if (request.preLoginCsrfCookie) {
      this.preLoginCsrf.consume(request.preLoginCsrfCookie);
      response.clearCookie(
        csrfCookieName(this.config),
        clearCookieOptions(this.config),
      );
    }

    response.cookie(
      sessionCookieName(this.config),
      result.rawSessionCredential,
      sessionCookieOptions(this.config),
    );
    return { user: result.user, csrfToken: result.csrfToken };
  }

  @Get('me')
  @ApiCookieAuth('graduate_session')
  @ApiOperation({ summary: 'Return the currently authenticated staff user' })
  @ApiDataResponse(
    { $ref: getSchemaPath(AuthSessionResponseDto) },
    'Current staff user and session CSRF token',
  )
  me(
    @CurrentSession() session: AuthenticatedSession,
    @Res({ passthrough: true }) response: Response,
  ): { readonly user: StaffAccountView; readonly csrfToken: string } {
    response.setHeader('Cache-Control', 'no-store');
    return { user: session.user, csrfToken: session.csrfToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth('graduate_session')
  @ApiOperation({ summary: 'Terminate the current staff session' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiNoContentResponse({ description: 'Current session terminated' })
  async logout(
    @CurrentSession() session: AuthenticatedSession,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    await this.staffAuth.logout(session);
    response.clearCookie(
      sessionCookieName(this.config),
      clearCookieOptions(this.config),
    );
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth('graduate_session')
  @ApiOperation({
    summary:
      'Change the current staff user password and invalidate all sessions',
  })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(StaffAccountDto) },
    'Updated staff account; all sessions invalidated',
  )
  async changePassword(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: ChangePasswordDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StaffAccountView> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const updated = await this.staffAuth.changePassword(session, body);
      response.clearCookie(
        sessionCookieName(this.config),
        clearCookieOptions(this.config),
      );
      return updated;
    } catch (error: unknown) {
      if (
        error instanceof ApiError &&
        error.getStatus() === 401 &&
        error.message === 'Authentication required'
      ) {
        response.clearCookie(
          sessionCookieName(this.config),
          clearCookieOptions(this.config),
        );
      }
      throw error;
    }
  }
}
