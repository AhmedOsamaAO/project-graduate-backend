import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import { parseCalendarDate } from '../../common/dates/office-calendar';
import { MAX_POSTGRES_INT4 } from '../../common/http/parse-positive-int.pipe';
import { hasControlCharacters } from '../students.validation';

export function TrimString() {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}

export function TransformQueryBoolean() {
  return Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === true || value === false) {
      return value;
    }
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    return value;
  });
}

export function NoControlChars(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'noControlChars',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && !hasControlCharacters(value);
        },
        defaultMessage(args): string {
          return `${args?.property ?? 'value'} must not contain control characters`;
        },
      },
    });
  };
}

export function IsCalendarDate(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isCalendarDate',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && parseCalendarDate(value) !== null;
        },
        defaultMessage(args): string {
          return `${args?.property ?? 'value'} must be a valid YYYY-MM-DD calendar date`;
        },
      },
    });
  };
}

export function PositiveInt4Field(example: number) {
  return applyDecorators(
    ApiProperty({
      minimum: 1,
      maximum: MAX_POSTGRES_INT4,
      example,
    }),
    IsInt(),
    Min(1),
    Max(MAX_POSTGRES_INT4),
  );
}

export function OptionalNullablePositiveInt4Field(options: {
  readonly example: number;
  readonly description?: string;
}) {
  return applyDecorators(
    ApiPropertyOptional({
      type: Number,
      nullable: true,
      minimum: 1,
      maximum: MAX_POSTGRES_INT4,
      example: options.example,
      ...(options.description ? { description: options.description } : {}),
    }),
    ValidateIf((_obj, value) => value !== undefined && value !== null),
    IsInt(),
    Min(1),
    Max(MAX_POSTGRES_INT4),
  );
}

export function OptionalNullableTextField(options: {
  readonly maxLength: number;
  readonly example: string;
}) {
  return applyDecorators(
    ApiPropertyOptional({
      type: String,
      nullable: true,
      maxLength: options.maxLength,
      example: options.example,
    }),
    ValidateIf((_obj, value) => value !== undefined && value !== null),
    TrimString(),
    IsString(),
    IsNotEmpty(),
    MaxLength(options.maxLength),
    NoControlChars(),
  );
}

export function OptionalNullableCalendarDateField(example: string) {
  return applyDecorators(
    ApiPropertyOptional({
      type: String,
      format: 'date',
      nullable: true,
      example,
    }),
    ValidateIf((_obj, value) => value !== undefined && value !== null),
    IsString(),
    IsCalendarDate(),
  );
}

export function OptionalIncludeArchivedField(description: string) {
  return applyDecorators(
    ApiPropertyOptional({
      type: Boolean,
      default: false,
      description,
    }),
    TransformQueryBoolean(),
    ValidateIf((_obj, value) => value !== undefined),
    IsBoolean(),
  );
}
