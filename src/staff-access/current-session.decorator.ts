import {
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { AuthenticatedSession } from './staff-auth.service';

export interface StaffAuthenticatedRequest extends Request {
  staffSession?: AuthenticatedSession;
  preLoginCsrfCookie?: string;
}

export const CurrentSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedSession => {
    const request = ctx.switchToHttp().getRequest<StaffAuthenticatedRequest>();
    if (!request.staffSession) {
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        ERROR_CODES.UNAUTHENTICATED,
        'Authentication required',
      );
    }
    return request.staffSession;
  },
);
