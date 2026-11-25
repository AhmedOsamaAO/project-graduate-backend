import {
  type ArgumentMetadata,
  HttpStatus,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { ApiError } from '../errors/api-error';
import { ERROR_CODES } from '../errors/error-codes';

export const MAX_POSTGRES_INT4 = 2_147_483_647;
const STRICT_POSITIVE_INT_PATTERN = /^[1-9]\d*$/;

/** Validates route parameters as strict positive 32-bit integers. */
@Injectable()
export class ParsePositiveIntPipe implements PipeTransform<
  string | number,
  number
> {
  transform(value: string | number, metadata: ArgumentMetadata): number {
    const field = metadata.data ?? 'id';
    // Global ValidationPipe({ transform: true }) converts @Param() number
    // values before route pipes execute, so both string and number inputs
    // must be validated here.
    if (typeof value === 'number') {
      if (
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > MAX_POSTGRES_INT4
      ) {
        throw invalidIntegerError(field);
      }
      return value;
    }

    if (typeof value !== 'string' || !STRICT_POSITIVE_INT_PATTERN.test(value)) {
      throw invalidIntegerError(field);
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_POSTGRES_INT4) {
      throw invalidIntegerError(field);
    }

    return parsed;
  }
}

function invalidIntegerError(field: string): ApiError {
  return new ApiError(
    HttpStatus.BAD_REQUEST,
    ERROR_CODES.VALIDATION_ERROR,
    'Validation failed',
    [{ field, message: `${field} must be a positive integer` }],
  );
}
