import { applyDecorators } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';

export class ApiErrorDto {
  @ApiProperty({ example: 'NOT_FOUND' })
  code!: string;

  @ApiProperty({ example: 'Not found' })
  message!: string;

  @ApiPropertyOptional({
    description: 'Field-level validation details or other safe context.',
    example: [{ field: 'name', message: 'name must be a string' }],
  })
  details?: unknown;
}

const COMMON_ERROR_RESPONSES = [
  { status: 400, description: 'Validation or request error' },
  { status: 401, description: 'Authentication required' },
  { status: 403, description: 'Forbidden or CSRF check failed' },
  { status: 404, description: 'Resource not found' },
  { status: 409, description: 'Stale version or invariant conflict' },
  { status: 429, description: 'Too many requests' },
  { status: 503, description: 'Required file or storage service unavailable' },
  { status: 500, description: 'Unexpected server error' },
] as const;

/**
 * Documents the shared error contract on a route or controller. The runtime
 * filter enforces the same shape for every failure.
 */
export function ApiCommonErrorResponses() {
  return applyDecorators(
    ApiExtraModels(ApiErrorDto),
    ...COMMON_ERROR_RESPONSES.map(({ status, description }) =>
      ApiResponse({
        status,
        description,
        schema: { $ref: getSchemaPath(ApiErrorDto) },
      }),
    ),
  );
}

export function ApiDataResponse(
  schema: Record<string, unknown>,
  description = 'Successful response',
) {
  return ApiOkResponse({
    description,
    schema: {
      type: 'object',
      required: ['data'],
      properties: { data: schema },
    },
  });
}
