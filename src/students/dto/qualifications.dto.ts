import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, ValidateIf } from 'class-validator';
import { PageQueryDto } from '../../common/http/page-query.dto';
import { DegreeLevel, EquivalencyStatus } from '../../generated/prisma/client';
import {
  QUALIFICATION_ARCHIVE_FILTERS,
  QUALIFICATION_SORT_FIELDS,
  type QualificationArchiveFilter,
  type QualificationSortField,
} from '../qualifications.validation';
import { SORT_DIRECTIONS, type SortDirection } from '../students.validation';
import {
  OptionalIncludeArchivedField,
  OptionalNullableCalendarDateField,
  OptionalNullablePositiveInt4Field,
  OptionalNullableTextField,
  PositiveInt4Field,
} from './dto-decorators';

function QualificationNameField() {
  return OptionalNullableTextField({
    maxLength: 200,
    example: 'Bachelor of Computer and Information Sciences',
  });
}

function AwardingInstitutionIdField() {
  return OptionalNullablePositiveInt4Field({
    example: 1,
    description:
      'Awarding educational institution ID; resolved automatically when facultyId or departmentId is supplied.',
  });
}

function AwardingFacultyIdField() {
  return OptionalNullablePositiveInt4Field({
    example: 1,
    description:
      'Awarding faculty ID; must belong to institutionId when both are supplied.',
  });
}

function AwardingDepartmentIdField() {
  return OptionalNullablePositiveInt4Field({
    example: 1,
    description:
      'Awarding department ID; must belong to facultyId when both are supplied.',
  });
}

function GraduationYearField() {
  return OptionalNullablePositiveInt4Field({
    example: 2023,
    description:
      'Positive Gregorian graduation year no later than the current Africa/Cairo year.',
  });
}

function OverallGradeField() {
  return OptionalNullableTextField({
    maxLength: 100,
    example: 'Very Good with Honors (3.65)',
  });
}

function DecisionNumberField() {
  return OptionalNullableTextField({
    maxLength: 100,
    example: 'EQ-2026/104',
  });
}

function DecisionDateField() {
  return OptionalNullableCalendarDateField('2026-09-15');
}

export class ListStudentQualificationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: DegreeLevel })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(DegreeLevel)
  degreeLevel?: DegreeLevel;

  @ApiPropertyOptional({ enum: EquivalencyStatus })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(EquivalencyStatus)
  equivalencyStatus?: EquivalencyStatus;

  @ApiPropertyOptional({
    enum: QUALIFICATION_ARCHIVE_FILTERS,
    default: 'ACTIVE',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(QUALIFICATION_ARCHIVE_FILTERS)
  archiveStatus?: QualificationArchiveFilter;

  @OptionalIncludeArchivedField(
    'Include qualifications when the owning student record is archived.',
  )
  includeArchivedStudent?: boolean;

  @ApiPropertyOptional({
    enum: QUALIFICATION_SORT_FIELDS,
    default: 'createdAt',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(QUALIFICATION_SORT_FIELDS)
  sortBy?: QualificationSortField;

  @ApiPropertyOptional({
    enum: SORT_DIRECTIONS,
    default: 'asc',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(SORT_DIRECTIONS)
  sortOrder?: SortDirection;
}

export class GetQualificationQueryDto {
  @OptionalIncludeArchivedField(
    'Include an archived qualification or one belonging to an archived student when explicitly requested.',
  )
  includeArchived?: boolean;
}

export class QualificationHistoryQueryDto extends PageQueryDto {
  @OptionalIncludeArchivedField(
    'Include history for an archived qualification or one belonging to an archived student when explicitly requested.',
  )
  includeArchived?: boolean;
}

export class CreateQualificationDto {
  @ApiProperty({ enum: DegreeLevel, example: DegreeLevel.BACHELOR })
  @IsEnum(DegreeLevel)
  degreeLevel!: DegreeLevel;

  @QualificationNameField()
  qualificationName?: string | null;

  @AwardingInstitutionIdField()
  institutionId?: number | null;

  @AwardingFacultyIdField()
  facultyId?: number | null;

  @AwardingDepartmentIdField()
  departmentId?: number | null;

  @GraduationYearField()
  graduationYear?: number | null;

  @OverallGradeField()
  overallGrade?: string | null;

  @ApiPropertyOptional({
    enum: EquivalencyStatus,
    default: EquivalencyStatus.NOT_ASSESSED,
    example: EquivalencyStatus.NOT_ASSESSED,
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(EquivalencyStatus)
  equivalencyStatus?: EquivalencyStatus;

  @DecisionNumberField()
  equivalencyDecisionNumber?: string | null;

  @DecisionDateField()
  equivalencyDecisionDate?: string | null;
}

export class UpdateQualificationDto {
  @PositiveInt4Field(1)
  expectedVersion!: number;

  @ApiPropertyOptional({ enum: DegreeLevel, example: DegreeLevel.BACHELOR })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(DegreeLevel)
  degreeLevel?: DegreeLevel;

  @QualificationNameField()
  qualificationName?: string | null;

  @AwardingInstitutionIdField()
  institutionId?: number | null;

  @AwardingFacultyIdField()
  facultyId?: number | null;

  @AwardingDepartmentIdField()
  departmentId?: number | null;

  @GraduationYearField()
  graduationYear?: number | null;

  @OverallGradeField()
  overallGrade?: string | null;

  @ApiPropertyOptional({
    enum: EquivalencyStatus,
    example: EquivalencyStatus.APPROVED,
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(EquivalencyStatus)
  equivalencyStatus?: EquivalencyStatus;

  @DecisionNumberField()
  equivalencyDecisionNumber?: string | null;

  @DecisionDateField()
  equivalencyDecisionDate?: string | null;
}

export class QualificationVersionActionDto {
  @PositiveInt4Field(1)
  expectedVersion!: number;
}

export class QualificationDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  studentId!: number;

  @ApiProperty({ enum: DegreeLevel, example: DegreeLevel.BACHELOR })
  degreeLevel!: DegreeLevel;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Bachelor of Computer and Information Sciences',
  })
  qualificationName!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 1 })
  institutionId!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1 })
  facultyId!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1 })
  departmentId!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 2023 })
  graduationYear!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Very Good with Honors (3.65)',
  })
  overallGrade!: string | null;

  @ApiProperty({
    enum: EquivalencyStatus,
    example: EquivalencyStatus.NOT_ASSESSED,
  })
  equivalencyStatus!: EquivalencyStatus;

  @ApiProperty({ type: String, nullable: true, example: 'EQ-2026/104' })
  equivalencyDecisionNumber!: string | null;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-09-15',
  })
  equivalencyDecisionDate!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
  })
  archivedAt!: string | null;

  @ApiProperty({ example: 1 })
  version!: number;

  @ApiProperty({ format: 'date-time', example: '2026-11-27T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-27T10:00:00.000Z' })
  updatedAt!: string;
}
