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
  STATUS_ERRORS,
  statusError,
  type ErrorEnvelope,
} from '../errors/error-codes';

const INTERNAL_ERROR: ErrorEnvelope = STATUS_ERRORS[500];

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

    // Plain Nest exceptions may carry parser, database, or filesystem text.
    // Only ApiError payloads are trusted to provide a public message.
    return { status, body: statusError(status) };
  }

  // Express middleware such as the body parser rejects client faults (too
  // large, unsupported charset or encoding) with plain `http-errors` objects
  // that Nest does not convert to HttpException. They are the caller's fault,
  // so keep their status, but never reuse the parser's own message.
  const clientStatus = clientErrorStatus(exception);
  if (clientStatus !== undefined) {
    return { status: clientStatus, body: statusError(clientStatus) };
  }

  return { status: 500, body: INTERNAL_ERROR };
}

function clientErrorStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) {
    return undefined;
  }

  const { status, statusCode } = exception as {
    status?: unknown;
    statusCode?: unknown;
  };
  const candidate = typeof status === 'number' ? status : statusCode;

  return typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 400 &&
    candidate < 500
    ? candidate
    : undefined;
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).code === 'string' &&
    typeof (value as Record<string, unknown>).message === 'string'
  );
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
