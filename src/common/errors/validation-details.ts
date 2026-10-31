import type { ValidationError } from 'class-validator';

export interface ValidationDetail {
  readonly field: string;
  readonly message: string;
}

export function flattenValidationErrors(
  errors: readonly ValidationError[],
  parent = '',
): ValidationDetail[] {
  const details: ValidationDetail[] = [];

  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;

    for (const message of Object.values(error.constraints ?? {})) {
      details.push({ field, message });
    }

    if (error.children?.length) {
      details.push(...flattenValidationErrors(error.children, field));
    }
  }

  return details;
}
