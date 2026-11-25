import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import { parseCalendarDate } from '../../common/dates/office-calendar';
import { PageQueryDto } from '../../common/http/page-query.dto';
import { MAX_POSTGRES_INT4 } from '../../common/http/parse-positive-int.pipe';
import { MilitaryStatus } from '../../generated/prisma/client';
import {
  SORT_DIRECTIONS,
  STUDENT_ARCHIVE_FILTERS,
  STUDENT_NATIONAL_ID_PATTERN,
  STUDENT_NATIONAL_ID_SEARCH_PATTERN,
  STUDENT_SORT_FIELDS,
  hasControlCharacters,
  normalizeArabicIndicDigits,
  type SortDirection,
  type StudentArchiveFilter,
  type StudentSortField,
} from '../students.validation';

function TrimString() {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}

function TrimOptionalQueryString() {
  return Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  });
}

function TransformQueryBoolean() {
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

function NoControlChars(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'studentNoControlChars',
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

function IsCalendarDate(validationOptions?: ValidationOptions) {
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

function PositiveInt4Field(example: number) {
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

function StudentFullNameField(optional: boolean) {
  const swagger = optional
    ? ApiPropertyOptional({ maxLength: 200, example: 'أحمد محمود علي' })
    : ApiProperty({ maxLength: 200, example: 'أحمد محمود علي' });

  return applyDecorators(
    swagger,
    ...(optional ? [ValidateIf((_obj, value) => value !== undefined)] : []),
    TrimString(),
    IsString(),
    IsNotEmpty(),
    MaxLength(200),
    NoControlChars(),
  );
}

function StudentNationalIdField(optional: boolean) {
  const options = {
    minLength: 14,
    maxLength: 14,
    pattern: '^[0-9]{14}$',
    example: '29901011234567',
    description:
      '14-digit Egyptian national ID; Arabic-Indic digits are normalized to 0–9 and leading zeros are preserved.',
  };
  const swagger = optional
    ? ApiPropertyOptional(options)
    : ApiProperty(options);

  return applyDecorators(
    swagger,
    ...(optional ? [ValidateIf((_obj, value) => value !== undefined)] : []),
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string'
        ? normalizeArabicIndicDigits(value.trim())
        : value,
    ),
    IsString(),
    NoControlChars(),
    Matches(STUDENT_NATIONAL_ID_PATTERN, {
      message: 'nationalId must contain exactly 14 digits',
    }),
  );
}

function OptionalNullableTextField(options: {
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

function OptionalNullableBirthDateField() {
  return applyDecorators(
    ApiPropertyOptional({
      type: String,
      format: 'date',
      nullable: true,
      example: '1999-05-14',
    }),
    ValidateIf((_obj, value) => value !== undefined && value !== null),
    IsString(),
    IsCalendarDate(),
  );
}

function OptionalNullableMilitaryStatusField() {
  return applyDecorators(
    ApiPropertyOptional({
      enum: MilitaryStatus,
      nullable: true,
      example: MilitaryStatus.EXEMPTED,
    }),
    ValidateIf((_obj, value) => value !== undefined && value !== null),
    IsEnum(MilitaryStatus),
  );
}

function OptionalQueryTextField(description: string, example: string) {
  return applyDecorators(
    ApiPropertyOptional({ description, maxLength: 200, example }),
    TrimOptionalQueryString(),
    ValidateIf((_obj, value) => value !== undefined),
    IsString(),
    MaxLength(200),
    NoControlChars(),
  );
}

function OptionalIncludeArchivedField() {
  return applyDecorators(
    ApiPropertyOptional({
      type: Boolean,
      default: false,
      description:
        'Include archived student records when explicitly requested.',
    }),
    TransformQueryBoolean(),
    ValidateIf((_obj, value) => value !== undefined),
    IsBoolean(),
  );
}

export class ListStudentsQueryDto extends PageQueryDto {
  @OptionalQueryTextField(
    'Case-insensitive full-name search or national-ID digit search (Arabic-Indic normalized, leading zeros preserved).',
    '001234',
  )
  search?: string;

  @OptionalQueryTextField(
    'Case-insensitive substring filter on student full name.',
    'أحمد',
  )
  fullName?: string;

  @ApiPropertyOptional({
    description:
      'National ID exact or prefix filter (1–14 digits, Arabic-Indic normalized, leading zeros preserved).',
    maxLength: 14,
    example: '001234',
  })
  @TrimOptionalQueryString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeArabicIndicDigits(value) : value,
  )
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString()
  @NoControlChars()
  @Matches(STUDENT_NATIONAL_ID_SEARCH_PATTERN, {
    message: 'nationalId filter must contain 1–14 digits',
  })
  nationalId?: string;

  @ApiPropertyOptional({ enum: MilitaryStatus })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(MilitaryStatus)
  militaryStatus?: MilitaryStatus;

  @ApiPropertyOptional({
    enum: STUDENT_ARCHIVE_FILTERS,
    default: 'ACTIVE',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(STUDENT_ARCHIVE_FILTERS)
  archiveStatus?: StudentArchiveFilter;

  @ApiPropertyOptional({
    enum: STUDENT_SORT_FIELDS,
    default: 'fullName',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(STUDENT_SORT_FIELDS)
  sortBy?: StudentSortField;

  @ApiPropertyOptional({
    enum: SORT_DIRECTIONS,
    default: 'asc',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(SORT_DIRECTIONS)
  sortOrder?: SortDirection;
}

export class GetStudentQueryDto {
  @OptionalIncludeArchivedField()
  includeArchived?: boolean;
}

export class StudentHistoryQueryDto extends PageQueryDto {
  @OptionalIncludeArchivedField()
  includeArchived?: boolean;
}

export class CreateStudentDto {
  @StudentFullNameField(false)
  fullName!: string;

  @StudentNationalIdField(false)
  nationalId!: string;

  @OptionalNullableTextField({ maxLength: 50, example: '01001234567' })
  phone?: string | null;

  @OptionalNullableBirthDateField()
  birthDate?: string | null;

  @OptionalNullableTextField({
    maxLength: 500,
    example: 'Zagazig, Sharqia',
  })
  address?: string | null;

  @OptionalNullableMilitaryStatusField()
  militaryStatus?: MilitaryStatus | null;
}

export class UpdateStudentDto {
  @PositiveInt4Field(1)
  expectedVersion!: number;

  @StudentFullNameField(true)
  fullName?: string;

  @StudentNationalIdField(true)
  nationalId?: string;

  @OptionalNullableTextField({ maxLength: 50, example: '01001234567' })
  phone?: string | null;

  @OptionalNullableBirthDateField()
  birthDate?: string | null;

  @OptionalNullableTextField({
    maxLength: 500,
    example: 'Zagazig, Sharqia',
  })
  address?: string | null;

  @OptionalNullableMilitaryStatusField()
  militaryStatus?: MilitaryStatus | null;
}

export class StudentVersionActionDto {
  @PositiveInt4Field(1)
  expectedVersion!: number;
}

export class StudentDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'أحمد محمود علي' })
  fullName!: string;

  @ApiProperty({ example: '29901011234567' })
  nationalId!: string;

  @ApiProperty({ type: String, nullable: true, example: '01001234567' })
  phone!: string | null;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '1999-05-14',
  })
  birthDate!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Zagazig, Sharqia' })
  address!: string | null;

  @ApiProperty({
    enum: MilitaryStatus,
    nullable: true,
    example: MilitaryStatus.EXEMPTED,
  })
  militaryStatus!: MilitaryStatus | null;

  @ApiProperty({ type: Number, nullable: true, example: null })
  selectedPhotoDocumentId!: number | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
  })
  archivedAt!: string | null;

  @ApiProperty({ example: 1 })
  version!: number;

  @ApiProperty({ format: 'date-time', example: '2026-11-25T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-25T10:00:00.000Z' })
  updatedAt!: string;
}
