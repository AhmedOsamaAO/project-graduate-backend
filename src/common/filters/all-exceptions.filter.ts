import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from '../errors/api-error';
import {
  ERROR_CODES,
  STATUS_TO_ERROR_CODE,
  STATUS_TO_MESSAGE,
  type ErrorEnvelope,
} from '../errors/error-codes';

const INTERNAL_ERROR: ErrorEnvelope = {
  code: ERROR_CODES.INTERNAL_ERROR,
  message: STATUS_TO_MESSAGE[500],
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    if (response.headersSent) {
      return;
    }

    const { status, body } = toErrorResponse(exception);

    if (status >= 500) {
      this.logUnexpected(exception, request.method, body.code);
    }

    response.status(status).json(body);
  }

  private logUnexpected(
    exception: unknown,
    method: string,
    code: ErrorEnvelope['code'],
  ): void {
    const name = exception instanceof Error ? exception.name : 'UnknownError';
    const frames =
      exception instanceof Error ? stackFrames(exception.stack) : '';

    // Never log exception messages or request URLs: they can contain national
    // IDs, credentials, query text, or raw database errors. Stack frames are
    // safe operator context; the request method is intentionally coarse.
    this.logger.error(
      `Unhandled ${method} request (${String(code)}, ${name})${
        frames ? `\n${frames}` : ''
      }`,
    );
  }
}

function toErrorResponse(exception: unknown): {
  status: number;
  body: ErrorEnvelope;
} {
  if (exception instanceof ApiError) {
    const response = exception.getResponse();
    const body = isErrorEnvelope(response)
      ? response
      : { code: exception.code, message: exception.message };

    return { status: exception.getStatus(), body };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();

    if (status >= 500) {
      return {
        status,
        body: {
          code: STATUS_TO_ERROR_CODE[status] ?? ERROR_CODES.SERVICE_UNAVAILABLE,
          message: STATUS_TO_MESSAGE[status] ?? STATUS_TO_MESSAGE[503],
        },
      };
    }

    return { status, body: publicHttpError(exception, status) };
  }

  return { status: 500, body: INTERNAL_ERROR };
}

function publicHttpError(
  exception: HttpException,
  status: number,
): ErrorEnvelope {
  const response = exception.getResponse();
  const fallbackCode = STATUS_TO_ERROR_CODE[status] ?? ERROR_CODES.BAD_REQUEST;
  const fallbackMessage = STATUS_TO_MESSAGE[status] ?? 'Request failed';

  if (typeof response === 'string') {
    return { code: fallbackCode, message: response };
  }

  if (!isRecord(response)) {
    return { code: fallbackCode, message: fallbackMessage };
  }

  if (Array.isArray(response.message)) {
    return {
      code: status === 400 ? ERROR_CODES.VALIDATION_ERROR : fallbackCode,
      message: status === 400 ? 'Validation failed' : fallbackMessage,
      details: response.message,
    };
  }

  const code = typeof response.code === 'string' ? response.code : fallbackCode;
  const message =
    typeof response.message === 'string' ? response.message : fallbackMessage;

  return {
    code,
    message,
    ...(response.details === undefined ? {} : { details: response.details }),
  };
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stackFrames(stack: string | undefined): string {
  if (!stack) {
    return '';
  }

  return stack
    .split('\n')
    .filter((line) => /^\s+at\s/.test(line))
    .join('\n');
}
