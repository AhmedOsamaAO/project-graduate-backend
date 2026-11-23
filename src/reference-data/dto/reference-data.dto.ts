import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
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
import { PageQueryDto } from '../../common/http/page-query.dto';
import { MAX_POSTGRES_INT4 } from '../../common/http/parse-positive-int.pipe';
import { InstitutionType } from '../../generated/prisma/client';
import {
  FACULTY_AND_DEPARTMENT_SORT_FIELDS,
  INSTITUTION_SORT_FIELDS,
  SORT_DIRECTIONS,
  hasControlCharacters,
  type CatalogSortField,
  type InstitutionSortField,
  type SortDirection,
} from '../reference-data.validation';

function TrimString() {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}

function TrimOptionalSearch() {
  return Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  });
}

function NoControlChars(validationOptions?: ValidationOptions) {
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

function PositiveInt4Field(options: {
  readonly optional?: boolean;
  readonly fromQuery?: boolean;
  readonly example: number;
}) {
  const swagger = options.optional
    ? ApiPropertyOptional({
        minimum: 1,
        maximum: MAX_POSTGRES_INT4,
        example: options.example,
      })
    : ApiProperty({
        minimum: 1,
        maximum: MAX_POSTGRES_INT4,
        example: options.example,
      });

  return applyDecorators(
    swagger,
    ...(options.optional
      ? [ValidateIf((_obj, value) => value !== undefined)]
      : []),
    ...(options.fromQuery ? [Type(() => Number)] : []),
    IsInt(),
    Min(1),
    Max(MAX_POSTGRES_INT4),
  );
}

function CatalogNameField(options: {
  readonly optional?: boolean;
  readonly example: string;
}) {
  const swagger = options.optional
    ? ApiPropertyOptional({ maxLength: 200, example: options.example })
    : ApiProperty({ maxLength: 200, example: options.example });

  return applyDecorators(
    swagger,
    ...(options.optional
      ? [ValidateIf((_obj, value) => value !== undefined)]
      : []),
    TrimString(),
    IsString(),
    IsNotEmpty(),
    MaxLength(200),
    NoControlChars(),
  );
}

function OptionalSearchField(description: string, example: string) {
  return applyDecorators(
    ApiPropertyOptional({ description, maxLength: 200, example }),
    TrimOptionalSearch(),
    ValidateIf((_obj, value) => value !== undefined),
    IsString(),
    MaxLength(200),
    NoControlChars(),
  );
}

function OptionalSortByField(allowedFields: readonly string[]) {
  return applyDecorators(
    ApiPropertyOptional({ enum: [...allowedFields], default: 'name' }),
    ValidateIf((_obj, value) => value !== undefined),
    IsIn(allowedFields),
  );
}

function OptionalSortOrderField() {
  return applyDecorators(
    ApiPropertyOptional({ enum: SORT_DIRECTIONS, default: 'asc' }),
    ValidateIf((_obj, value) => value !== undefined),
    IsIn(SORT_DIRECTIONS),
  );
}

export class ListInstitutionsQueryDto extends PageQueryDto {
  @OptionalSearchField(
    'Case-insensitive substring filter on institution name.',
    'Cairo',
  )
  search?: string;

  @ApiPropertyOptional({ enum: InstitutionType })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(InstitutionType)
  institutionType?: InstitutionType;

  @OptionalSortByField(INSTITUTION_SORT_FIELDS)
  sortBy?: InstitutionSortField;

  @OptionalSortOrderField()
  sortOrder?: SortDirection;
}

export class CreateInstitutionDto {
  @CatalogNameField({ example: 'Cairo University' })
  name!: string;

  @ApiProperty({
    enum: InstitutionType,
    example: InstitutionType.PUBLIC_UNIVERSITY,
  })
  @IsEnum(InstitutionType)
  institutionType!: InstitutionType;
}

export class UpdateInstitutionDto {
  @PositiveInt4Field({ example: 1 })
  expectedVersion!: number;

  @CatalogNameField({ optional: true, example: 'Cairo University' })
  name?: string;

  @ApiPropertyOptional({ enum: InstitutionType })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(InstitutionType)
  institutionType?: InstitutionType;
}

export class ListFacultiesQueryDto extends PageQueryDto {
  @OptionalSearchField(
    'Case-insensitive substring filter on faculty name.',
    'Engineering',
  )
  search?: string;

  @PositiveInt4Field({ optional: true, fromQuery: true, example: 1 })
  institutionId?: number;

  @OptionalSortByField(FACULTY_AND_DEPARTMENT_SORT_FIELDS)
  sortBy?: CatalogSortField;

  @OptionalSortOrderField()
  sortOrder?: SortDirection;
}

export class CreateFacultyDto {
  @PositiveInt4Field({ example: 2 })
  institutionId!: number;

  @CatalogNameField({ example: 'Faculty of Engineering' })
  name!: string;
}

export class UpdateFacultyDto {
  @PositiveInt4Field({ example: 1 })
  expectedVersion!: number;

  @PositiveInt4Field({ optional: true, example: 2 })
  institutionId?: number;

  @CatalogNameField({ optional: true, example: 'Faculty of Engineering' })
  name?: string;
}

export class ListDepartmentsQueryDto extends PageQueryDto {
  @OptionalSearchField(
    'Case-insensitive substring filter on department name.',
    'Computer Science',
  )
  search?: string;

  @PositiveInt4Field({ optional: true, fromQuery: true, example: 1 })
  facultyId?: number;

  @PositiveInt4Field({ optional: true, fromQuery: true, example: 1 })
  institutionId?: number;

  @OptionalSortByField(FACULTY_AND_DEPARTMENT_SORT_FIELDS)
  sortBy?: CatalogSortField;

  @OptionalSortOrderField()
  sortOrder?: SortDirection;
}

export class CreateDepartmentDto {
  @PositiveInt4Field({ example: 1 })
  facultyId!: number;

  @CatalogNameField({ example: 'Computer Science' })
  name!: string;
}

export class UpdateDepartmentDto {
  @PositiveInt4Field({ example: 1 })
  expectedVersion!: number;

  @PositiveInt4Field({ optional: true, example: 1 })
  facultyId?: number;

  @CatalogNameField({ optional: true, example: 'Information Technology' })
  name?: string;
}

export class DeleteCatalogEntryQueryDto {
  @PositiveInt4Field({ fromQuery: true, example: 1 })
  expectedVersion!: number;
}

export class EducationalInstitutionDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Zagazig University' })
  name!: string;

  @ApiProperty({
    enum: InstitutionType,
    example: InstitutionType.PUBLIC_UNIVERSITY,
  })
  institutionType!: InstitutionType;

  @ApiProperty({ example: 1 })
  version!: number;

  @ApiProperty({ format: 'date-time', example: '2026-11-23T12:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-23T12:00:00.000Z' })
  updatedAt!: string;
}

export class FacultyDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  institutionId!: number;

  @ApiProperty({ example: 'Faculty of Computer and Information' })
  name!: string;

  @ApiProperty({ example: 1 })
  version!: number;

  @ApiProperty({ format: 'date-time', example: '2026-11-23T12:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-23T12:00:00.000Z' })
  updatedAt!: string;
}

export class DepartmentDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  facultyId!: number;

  @ApiProperty({ example: 'Computer Science' })
  name!: string;

  @ApiProperty({ example: 1 })
  version!: number;

  @ApiProperty({ format: 'date-time', example: '2026-11-23T12:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-23T12:00:00.000Z' })
  updatedAt!: string;
}
