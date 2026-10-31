export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  STALE_VERSION: 'STALE_VERSION',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

interface StatusError {
  readonly code: ErrorCode;
  readonly message: string;
}

export const STATUS_ERRORS: Readonly<Record<number, StatusError>> = {
  400: { code: ERROR_CODES.BAD_REQUEST, message: 'Bad request' },
  401: {
    code: ERROR_CODES.UNAUTHENTICATED,
    message: 'Authentication required',
  },
  403: { code: ERROR_CODES.FORBIDDEN, message: 'Forbidden' },
  404: { code: ERROR_CODES.NOT_FOUND, message: 'Not found' },
  409: { code: ERROR_CODES.CONFLICT, message: 'Conflict' },
  429: { code: ERROR_CODES.RATE_LIMITED, message: 'Too many requests' },
  500: {
    code: ERROR_CODES.INTERNAL_ERROR,
    message: 'An unexpected error occurred',
  },
  503: {
    code: ERROR_CODES.SERVICE_UNAVAILABLE,
    message: 'Service unavailable',
  },
};

/**
 * Returns the shared code and safe message for an HTTP status. Unknown 4xx
 * statuses use the generic request error; unknown 5xx statuses are treated as
 * unavailable rather than exposing an exception message.
 */
export function statusError(status: number): StatusError {
  return (
    STATUS_ERRORS[status] ??
    (status >= 500
      ? STATUS_ERRORS[503]
      : { code: ERROR_CODES.BAD_REQUEST, message: 'Request failed' })
  );
}
