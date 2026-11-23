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
  CATALOG_SORT_FIELDS,
  INSTITUTION_SORT_FIELDS,
  SORT_DIRECTIONS,
  type CatalogSortField,
  type InstitutionSortField,
  type SortDirection,
} from '../reference-data.service';

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
          if (typeof value !== 'string') {
            return false;
          }
          for (const character of value) {
            const code = character.charCodeAt(0);
            if (code < 32 || code === 127) {
              return false;
            }
          }
          return true;
        },
        defaultMessage(args): string {
          return `${args?.property ?? 'value'} must not contain control characters`;
        },
      },
    });
  };
}

export class ListInstitutionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    description: 'Case-insensitive substring filter on institution name.',
    maxLength: 200,
    example: 'Cairo',
  })
  @TrimOptionalSearch()
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString()
  @MaxLength(200)
  @NoControlChars()
  search?: string;

  @ApiPropertyOptional({ enum: InstitutionType })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(InstitutionType)
  institutionType?: InstitutionType;

  @ApiPropertyOptional({
    enum: INSTITUTION_SORT_FIELDS,
    default: 'name',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(INSTITUTION_SORT_FIELDS)
  sortBy?: InstitutionSortField;

  @ApiPropertyOptional({
    enum: SORT_DIRECTIONS,
    default: 'asc',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(SORT_DIRECTIONS)
  sortOrder?: SortDirection;
}

export class CreateInstitutionDto {
  @ApiProperty({ maxLength: 200, example: 'Cairo University' })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @NoControlChars()
  name!: string;

  @ApiProperty({
    enum: InstitutionType,
    example: InstitutionType.PUBLIC_UNIVERSITY,
  })
  @IsEnum(InstitutionType)
  institutionType!: InstitutionType;
}

export class UpdateInstitutionDto {
  @ApiProperty({ minimum: 1, maximum: MAX_POSTGRES_INT4, example: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_POSTGRES_INT4)
  expectedVersion!: number;

  @ApiPropertyOptional({ maxLength: 200, example: 'Cairo University' })
  @ValidateIf((_obj, value) => value !== undefined)
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @NoControlChars()
  name?: string;

  @ApiPropertyOptional({ enum: InstitutionType })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(InstitutionType)
  institutionType?: InstitutionType;
}

export class ListFacultiesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    description: 'Case-insensitive substring filter on faculty name.',
    maxLength: 200,
    example: 'Engineering',
  })
  @TrimOptionalSearch()
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString()
  @MaxLength(200)
  @NoControlChars()
  search?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_POSTGRES_INT4, example: 1 })
  @ValidateIf((_obj, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_POSTGRES_INT4)
  institutionId?: number;

  @ApiPropertyOptional({
    enum: CATALOG_SORT_FIELDS,
    default: 'name',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(CATALOG_SORT_FIELDS)
  sortBy?: CatalogSortField;

  @ApiPropertyOptional({
    enum: SORT_DIRECTIONS,
    default: 'asc',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(SORT_DIRECTIONS)
  sortOrder?: SortDirection;
}

export class CreateFacultyDto {
  @ApiProperty({ minimum: 1, maximum: MAX_POSTGRES_INT4, example: 2 })
  @IsInt()
  @Min(1)
  @Max(MAX_POSTGRES_INT4)
  institutionId!: number;

  @ApiProperty({ maxLength: 200, example: 'Faculty of Engineering' })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @NoControlChars()
  name!: string;
}

export class UpdateFacultyDto {
  @ApiProperty({ minimum: 1, maximum: MAX_POSTGRES_INT4, example: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_POSTGRES_INT4)
  expectedVersion!: number;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_POSTGRES_INT4, example: 2 })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(MAX_POSTGRES_INT4)
  institutionId?: number;

  @ApiPropertyOptional({ maxLength: 200, example: 'Faculty of Engineering' })
  @ValidateIf((_obj, value) => value !== undefined)
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @NoControlChars()
  name?: string;
}

export class ListDepartmentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    description: 'Case-insensitive substring filter on department name.',
    maxLength: 200,
    example: 'Computer Science',
  })
  @TrimOptionalSearch()
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString()
  @MaxLength(200)
  @NoControlChars()
  search?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_POSTGRES_INT4, example: 1 })
  @ValidateIf((_obj, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_POSTGRES_INT4)
  facultyId?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_POSTGRES_INT4, example: 1 })
  @ValidateIf((_obj, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_POSTGRES_INT4)
  institutionId?: number;

  @ApiPropertyOptional({
    enum: CATALOG_SORT_FIELDS,
    default: 'name',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(CATALOG_SORT_FIELDS)
  sortBy?: CatalogSortField;

  @ApiPropertyOptional({
    enum: SORT_DIRECTIONS,
    default: 'asc',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(SORT_DIRECTIONS)
  sortOrder?: SortDirection;
}

export class CreateDepartmentDto {
  @ApiProperty({ minimum: 1, maximum: MAX_POSTGRES_INT4, example: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_POSTGRES_INT4)
  facultyId!: number;

  @ApiProperty({ maxLength: 200, example: 'Computer Science' })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @NoControlChars()
  name!: string;
}

export class UpdateDepartmentDto {
  @ApiProperty({ minimum: 1, maximum: MAX_POSTGRES_INT4, example: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_POSTGRES_INT4)
  expectedVersion!: number;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_POSTGRES_INT4, example: 1 })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(MAX_POSTGRES_INT4)
  facultyId?: number;

  @ApiPropertyOptional({ maxLength: 200, example: 'Information Technology' })
  @ValidateIf((_obj, value) => value !== undefined)
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @NoControlChars()
  name?: string;
}

export class DeleteCatalogEntryQueryDto {
  @ApiProperty({ minimum: 1, maximum: MAX_POSTGRES_INT4, example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_POSTGRES_INT4)
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

  @ApiProperty({ example: true })
  isFixedOffice!: boolean;

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

  @ApiProperty({ example: true })
  isFixedOffice!: boolean;

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
