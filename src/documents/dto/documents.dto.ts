import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
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
} from 'class-validator';
import { PageQueryDto } from '../../common/http/page-query.dto';
import { MAX_POSTGRES_INT4 } from '../../common/http/parse-positive-int.pipe';
import {
  DocumentAvailability,
  DocumentType,
  FileOperationKind,
  FileOperationStatus,
} from '../../generated/prisma/client';
import {
  NoControlChars,
  OptionalIncludeArchivedField,
  OptionalNullablePositiveInt4Field,
  OptionalNullableTextField,
  PositiveInt4Field,
  TrimString,
} from '../../students/dto/dto-decorators';
import {
  SORT_DIRECTIONS,
  type SortDirection,
} from '../../students/students.validation';
import {
  DOCUMENT_ARCHIVE_FILTERS,
  DOCUMENT_DOWNLOAD_DISPOSITIONS,
  DOCUMENT_SORT_FIELDS,
  STUDENT_DOCUMENT_TYPES,
  type DocumentArchiveFilter,
  type DocumentDownloadDisposition,
  type DocumentSortField,
} from '../documents.validation';

export class ListStudentDocumentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: STUDENT_DOCUMENT_TYPES })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(STUDENT_DOCUMENT_TYPES)
  documentType?: DocumentType;

  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: MAX_POSTGRES_INT4,
    example: 1,
    description: 'Filter documents linked to a specific qualification ID.',
  })
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed === '' ? undefined : Number(trimmed);
    }
    return value;
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(MAX_POSTGRES_INT4)
  qualificationId?: number;

  @ApiPropertyOptional({
    enum: DOCUMENT_ARCHIVE_FILTERS,
    default: 'ACTIVE',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(DOCUMENT_ARCHIVE_FILTERS)
  archiveStatus?: DocumentArchiveFilter;

  @OptionalIncludeArchivedField(
    'Include documents when the owning student record is archived.',
  )
  includeArchivedStudent?: boolean;

  @OptionalIncludeArchivedField(
    'Include documents linked to an archived qualification record.',
  )
  includeArchivedQualification?: boolean;

  @ApiPropertyOptional({
    enum: DOCUMENT_SORT_FIELDS,
    default: 'uploadedAt',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(DOCUMENT_SORT_FIELDS)
  sortBy?: DocumentSortField;

  @ApiPropertyOptional({
    enum: SORT_DIRECTIONS,
    default: 'desc',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(SORT_DIRECTIONS)
  sortOrder?: SortDirection;
}

export class ListSupervisorDocumentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: DOCUMENT_ARCHIVE_FILTERS,
    default: 'ACTIVE',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(DOCUMENT_ARCHIVE_FILTERS)
  archiveStatus?: DocumentArchiveFilter;

  @ApiPropertyOptional({
    enum: DOCUMENT_SORT_FIELDS,
    default: 'uploadedAt',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(DOCUMENT_SORT_FIELDS)
  sortBy?: DocumentSortField;

  @ApiPropertyOptional({
    enum: SORT_DIRECTIONS,
    default: 'desc',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(SORT_DIRECTIONS)
  sortOrder?: SortDirection;
}

export class GetDocumentQueryDto {
  @OptionalIncludeArchivedField(
    'Include an archived document or one under an archived student or qualification.',
  )
  includeArchived?: boolean;
}

export class DownloadDocumentQueryDto {
  @OptionalIncludeArchivedField(
    'Download an archived document or one under an archived student or qualification.',
  )
  includeArchived?: boolean;

  @ApiPropertyOptional({
    enum: DOCUMENT_DOWNLOAD_DISPOSITIONS,
    default: 'attachment',
    description:
      'Requested Content-Disposition; Office documents (DOCX/XLSX) always download as attachments.',
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(DOCUMENT_DOWNLOAD_DISPOSITIONS)
  disposition?: DocumentDownloadDisposition;
}

export class DocumentHistoryQueryDto extends PageQueryDto {
  @OptionalIncludeArchivedField(
    'Include history for an archived document or one under an archived parent.',
  )
  includeArchived?: boolean;
}

export class UpdateDocumentDto {
  @PositiveInt4Field(1)
  expectedVersion!: number;

  @OptionalNullablePositiveInt4Field({
    example: 1,
    description:
      'Optional qualification belonging to the same student, or null to unlink (student documents only).',
  })
  qualificationId?: number | null;

  @ApiPropertyOptional({ enum: DocumentType })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(DocumentType)
  documentType?: DocumentType;

  @OptionalNullableTextField({
    maxLength: 500,
    example: 'External supervision CV and institutional approval memo',
  })
  description?: string | null;
}

export class DocumentVersionActionDto {
  @PositiveInt4Field(1)
  expectedVersion!: number;
}

export class LookupFileOperationByKeyQueryDto {
  @ApiPropertyOptional({
    enum: FileOperationKind,
    default: FileOperationKind.UPLOAD,
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsEnum(FileOperationKind)
  kind: FileOperationKind = FileOperationKind.UPLOAD;

  @ApiProperty({ maxLength: 128, example: 'upload-req-1234' })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @NoControlChars()
  idempotencyKey!: string;
}

export class DocumentDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ type: Number, nullable: true, example: 1 })
  studentId!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: null })
  supervisorId!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1 })
  qualificationId!: number | null;

  @ApiProperty({
    enum: DocumentType,
    example: DocumentType.BACHELOR_CERTIFICATE,
  })
  documentType!: DocumentType;

  @ApiProperty({ type: String, nullable: true, example: null })
  description!: string | null;

  @ApiProperty({ example: 'bachelor-certificate.pdf' })
  originalFileName!: string;

  @ApiProperty({ example: 'application/pdf' })
  mimeType!: string;

  @ApiProperty({ example: 24576 })
  byteSize!: number;

  @ApiProperty({ format: 'date-time', example: '2026-11-28T10:00:00.000Z' })
  uploadedAt!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
  })
  archivedAt!: string | null;

  @ApiProperty({
    enum: DocumentAvailability,
    example: DocumentAvailability.AVAILABLE,
  })
  availability!: DocumentAvailability;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
  })
  deletedAt!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: null })
  deletedByStaffUserId!: number | null;

  @ApiProperty({ example: 1 })
  version!: number;

  @ApiProperty({ format: 'date-time', example: '2026-11-28T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-28T10:00:00.000Z' })
  updatedAt!: string;
}

export class FileOperationDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ enum: FileOperationKind, example: FileOperationKind.UPLOAD })
  kind!: FileOperationKind;

  @ApiProperty({
    enum: FileOperationStatus,
    example: FileOperationStatus.COMPLETED,
  })
  status!: FileOperationStatus;

  @ApiProperty({ type: Number, nullable: true, example: 1 })
  studentId!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: null })
  supervisorId!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 10 })
  documentId!: number | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  failureCode!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  failureMessage!: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-11-28T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-28T10:00:00.000Z' })
  updatedAt!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-11-28T10:00:01.000Z',
  })
  completedAt!: string | null;
}
