import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../common/http/page-query.dto';
import {
  AcademicRank,
  ExternalApprovalStatus,
  SupervisorAffiliation,
} from '../../generated/prisma/client';
import {
  NoControlChars,
  OptionalNullablePositiveInt4Field,
  OptionalNullableTextField,
  OptionalQueryPositiveInt4Field,
  OptionalQueryTextField,
  PositiveInt4Field,
  TrimOptionalQueryString,
  TrimString,
} from '../../students/dto/dto-decorators';
import {
  SORT_DIRECTIONS,
  type SortDirection,
} from '../../students/students.validation';
import {
  SUPERVISOR_ACTIVITY_FILTERS,
  SUPERVISOR_SORT_FIELDS,
  type SupervisorActivityFilter,
  type SupervisorSortField,
} from '../supervisors.validation';

function SupervisorFullNameField(optional: boolean) {
  const swagger = optional
    ? ApiPropertyOptional({ maxLength: 200, example: 'د. هالة مصطفى أحمد' })
    : ApiProperty({ maxLength: 200, example: 'د. هالة مصطفى أحمد' });

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

function OptionalNullableEmailField() {
  return applyDecorators(
    ApiPropertyOptional({
      type: String,
      nullable: true,
      maxLength: 254,
      example: 'supervisor@example.edu.eg',
    }),
    ValidateIf((_obj, value) => value !== undefined && value !== null),
    TrimString(),
    IsString(),
    IsNotEmpty(),
    MaxLength(254),
    NoControlChars(),
    IsEmail(),
  );
}

function OptionalNullableSupervisorNationalIdField() {
  return OptionalNullableTextField({
    maxLength: 50,
    example: '00123456',
  });
}

function SupervisorDepartmentIdField() {
  return OptionalNullablePositiveInt4Field({
    example: 1,
    description:
      'Required operating-faculty department for INTERNAL supervisors; optional catalog department for EXTERNAL supervisors.',
  });
}

function SupervisorWorkplaceField() {
  return OptionalNullableTextField({
    maxLength: 200,
    example: 'Cairo University',
  });
}

export class ListSupervisorsQueryDto extends PageQueryDto {
  @OptionalQueryTextField(
    'Case-insensitive search matching supervisor full name or national ID.',
    '00123',
  )
  search?: string;

  @OptionalQueryTextField(
    'Case-insensitive substring filter on supervisor full name.',
    'هالة',
  )
  fullName?: string;

  @ApiPropertyOptional({
    description:
      'Case-insensitive substring filter on supervisor national ID (leading zeros preserved).',
    maxLength: 50,
    example: '00123',
  })
  @TrimOptionalQueryString()
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString()
  @MaxLength(50)
  @NoControlChars()
  nationalId?: string;

  @ApiPropertyOptional({ enum: AcademicRank })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(AcademicRank)
  academicRank?: AcademicRank;

  @ApiPropertyOptional({ enum: SupervisorAffiliation })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(SupervisorAffiliation)
  affiliation?: SupervisorAffiliation;

  @OptionalQueryPositiveInt4Field({
    example: 1,
    description: 'Filter supervisors assigned to a specific department ID.',
  })
  departmentId?: number;

  @ApiPropertyOptional({ enum: ExternalApprovalStatus })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(ExternalApprovalStatus)
  externalApprovalStatus?: ExternalApprovalStatus;

  @ApiPropertyOptional({
    enum: SUPERVISOR_ACTIVITY_FILTERS,
    default: 'ALL',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(SUPERVISOR_ACTIVITY_FILTERS)
  activityStatus?: SupervisorActivityFilter;

  @ApiPropertyOptional({
    enum: SUPERVISOR_SORT_FIELDS,
    default: 'fullName',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(SUPERVISOR_SORT_FIELDS)
  sortBy?: SupervisorSortField;

  @ApiPropertyOptional({
    enum: SORT_DIRECTIONS,
    default: 'asc',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(SORT_DIRECTIONS)
  sortOrder?: SortDirection;
}

export class CreateSupervisorDto {
  @SupervisorFullNameField(false)
  fullName!: string;

  @ApiProperty({ enum: AcademicRank, example: AcademicRank.PROFESSOR })
  @IsEnum(AcademicRank)
  academicRank!: AcademicRank;

  @ApiProperty({
    enum: SupervisorAffiliation,
    example: SupervisorAffiliation.INTERNAL,
  })
  @IsEnum(SupervisorAffiliation)
  affiliation!: SupervisorAffiliation;

  @SupervisorDepartmentIdField()
  departmentId?: number | null;

  @SupervisorWorkplaceField()
  workplace?: string | null;

  @OptionalNullableTextField({ maxLength: 50, example: '01001234567' })
  phone?: string | null;

  @OptionalNullableEmailField()
  email?: string | null;

  @OptionalNullableSupervisorNationalIdField()
  nationalId?: string | null;
}

export class UpdateSupervisorDto {
  @PositiveInt4Field(1)
  expectedVersion!: number;

  @SupervisorFullNameField(true)
  fullName?: string;

  @ApiPropertyOptional({ enum: AcademicRank, example: AcademicRank.LECTURER })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(AcademicRank)
  academicRank?: AcademicRank;

  @ApiPropertyOptional({
    enum: SupervisorAffiliation,
    example: SupervisorAffiliation.EXTERNAL,
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(SupervisorAffiliation)
  affiliation?: SupervisorAffiliation;

  @SupervisorDepartmentIdField()
  departmentId?: number | null;

  @SupervisorWorkplaceField()
  workplace?: string | null;

  @OptionalNullableTextField({ maxLength: 50, example: '01001234567' })
  phone?: string | null;

  @OptionalNullableEmailField()
  email?: string | null;

  @OptionalNullableSupervisorNationalIdField()
  nationalId?: string | null;
}

export class UpdateSupervisorExternalApprovalDto {
  @PositiveInt4Field(1)
  expectedVersion!: number;

  @ApiProperty({
    enum: ExternalApprovalStatus,
    example: ExternalApprovalStatus.APPROVED,
  })
  @IsEnum(ExternalApprovalStatus)
  status!: ExternalApprovalStatus;

  @OptionalNullableTextField({
    maxLength: 500,
    example: 'Supporting institutional endorsement letter is incomplete',
  })
  rejectionReason?: string | null;
}

export class SupervisorVersionActionDto {
  @PositiveInt4Field(1)
  expectedVersion!: number;
}

export class SupervisorDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'د. هالة مصطفى أحمد' })
  fullName!: string;

  @ApiProperty({ enum: AcademicRank, example: AcademicRank.PROFESSOR })
  academicRank!: AcademicRank;

  @ApiProperty({
    enum: SupervisorAffiliation,
    example: SupervisorAffiliation.INTERNAL,
  })
  affiliation!: SupervisorAffiliation;

  @ApiProperty({ type: Number, nullable: true, example: 1 })
  departmentId!: number | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  workplace!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '01001234567' })
  phone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'supervisor@example.edu.eg',
  })
  email!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '00123456' })
  nationalId!: string | null;

  @ApiProperty({
    enum: ExternalApprovalStatus,
    nullable: true,
    example: null,
  })
  externalApprovalStatus!: ExternalApprovalStatus | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  externalRejectionReason!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
  })
  deactivatedAt!: string | null;

  @ApiProperty({ example: 1 })
  version!: number;

  @ApiProperty({ format: 'date-time', example: '2026-11-28T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-28T10:00:00.000Z' })
  updatedAt!: string;
}
