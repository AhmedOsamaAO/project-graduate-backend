import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * An HTTP error with an explicit, stable public code and a message that is
 * safe to return to clients.
 */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    details?: unknown,
  ) {
    super(
      {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
      status,
    );
  }
}
