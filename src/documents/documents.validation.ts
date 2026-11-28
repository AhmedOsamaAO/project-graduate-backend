import { HttpStatus } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  DocumentType,
  FileOperationKind,
  type Prisma,
} from '../generated/prisma/client';
import {
  STUDENT_ARCHIVE_FILTERS,
  hasControlCharacters,
  validatePositiveInt4,
  validationError,
  type SortDirection,
  type StudentArchiveFilter,
} from '../students/students.validation';
import { OFFICE_ATTACHMENT_MIME_TYPES } from './file-format.validator';

export const DOCUMENT_ARCHIVE_FILTERS = STUDENT_ARCHIVE_FILTERS;
export type DocumentArchiveFilter = StudentArchiveFilter;

export const DOCUMENT_SORT_FIELDS = [
  'uploadedAt',
  'documentType',
  'originalFileName',
  'id',
] as const;
export type DocumentSortField = (typeof DOCUMENT_SORT_FIELDS)[number];

export const DOCUMENT_DOWNLOAD_DISPOSITIONS = ['inline', 'attachment'] as const;
export type DocumentDownloadDisposition =
  (typeof DOCUMENT_DOWNLOAD_DISPOSITIONS)[number];

const VALID_DOCUMENT_TYPES = new Set<string>(Object.values(DocumentType));
const VALID_OPERATION_KINDS = new Set<string>(Object.values(FileOperationKind));
const POSITIVE_INTEGER_TEXT = /^[1-9]\d*$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_ORIGINAL_FILENAME_LENGTH = 255;

export function validateDocumentType(value: DocumentType): DocumentType {
  if (typeof value !== 'string' || !VALID_DOCUMENT_TYPES.has(value)) {
    throw validationError(
      'documentType',
      'documentType must be an approved student document category',
    );
  }
  return value;
}

export function validateOptionalDocumentTypeFilter(
  value: DocumentType | undefined,
): DocumentType | undefined {
  if (value === undefined) {
    return undefined;
  }
  return validateDocumentType(value);
}

export function validateOptionalQualificationId(
  value: number | null | undefined,
): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return validatePositiveInt4(value, 'qualificationId');
}

export function parseMultipartQualificationId(
  raw: string | undefined,
): number | null {
  if (raw === undefined) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw validationError(
      'qualificationId',
      'qualificationId must be a positive integer',
    );
  }
  const trimmed = raw.trim();
  if (!POSITIVE_INTEGER_TEXT.test(trimmed)) {
    throw validationError(
      'qualificationId',
      'qualificationId must be a positive integer',
    );
  }
  return validatePositiveInt4(Number(trimmed), 'qualificationId');
}

export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw validationError(
      'idempotencyKey',
      'Idempotency-Key header is required',
    );
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    hasControlCharacters(trimmed)
  ) {
    throw validationError(
      'idempotencyKey',
      `Idempotency-Key must contain 1–${MAX_IDEMPOTENCY_KEY_LENGTH} printable characters`,
    );
  }
  return trimmed;
}

export function sanitizeOriginalFileName(raw: string): string {
  if (typeof raw !== 'string') {
    throw validationError(
      'originalFileName',
      'Uploaded filename must be a string',
    );
  }
  const normalizedSlashes = raw.replace(/\\/g, '/');
  const lastSlash = normalizedSlashes.lastIndexOf('/');
  const baseName = normalizedSlashes.slice(lastSlash + 1).trim();
  if (
    !baseName ||
    baseName === '.' ||
    baseName === '..' ||
    baseName.length > MAX_ORIGINAL_FILENAME_LENGTH ||
    hasControlCharacters(baseName)
  ) {
    throw validationError(
      'originalFileName',
      `originalFileName must be a valid filename of 1–${MAX_ORIGINAL_FILENAME_LENGTH} printable characters`,
    );
  }
  return baseName;
}

export function validateDocumentDisposition(
  value: DocumentDownloadDisposition | undefined,
): DocumentDownloadDisposition {
  if (value === undefined) {
    return 'attachment';
  }
  if (
    typeof value !== 'string' ||
    !(DOCUMENT_DOWNLOAD_DISPOSITIONS as readonly string[]).includes(value)
  ) {
    throw validationError(
      'disposition',
      'disposition must be inline or attachment',
    );
  }
  return value;
}

export function validateFileOperationKind(
  value: FileOperationKind,
): FileOperationKind {
  if (typeof value !== 'string' || !VALID_OPERATION_KINDS.has(value)) {
    throw validationError('kind', 'kind must be UPLOAD or DELETE');
  }
  return value;
}

/**
 * Forces Office documents to download as attachments while sanitizing both the
 * quoted ASCII fallback and RFC 5987 UTF-8 filename parameter.
 */
export function buildContentDisposition(
  originalFileName: string,
  mimeType: string,
  requestedDisposition: DocumentDownloadDisposition = 'attachment',
): string {
  const effectiveDisposition: DocumentDownloadDisposition =
    OFFICE_ATTACHMENT_MIME_TYPES.has(mimeType)
      ? 'attachment'
      : requestedDisposition;

  const safeName = sanitizeOriginalFileName(originalFileName);
  const asciiFallback = toSafeAsciiFilename(safeName);
  const encodedUtf8 = encodeRfc5987Value(safeName);

  return `${effectiveDisposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodedUtf8}`;
}

function toSafeAsciiFilename(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  const rawStem = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
  const rawExt = lastDot > 0 ? fileName.slice(lastDot + 1) : '';

  const cleanStem = rawStem
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\;/:*?<>|%]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[._\s]+|[._\s]+$/g, '');

  const cleanExt = rawExt.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  const stem = cleanStem.length > 0 ? cleanStem.slice(0, 100) : 'document';
  return cleanExt.length > 0 ? `${stem}.${cleanExt}` : stem;
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface UploadRequestFingerprintInput {
  readonly studentId: number;
  readonly documentType: DocumentType;
  readonly qualificationId: number | null;
  readonly originalFileName: string;
  readonly byteSize: number;
  readonly contentSha256: string;
}

export function computeUploadRequestFingerprint(
  input: UploadRequestFingerprintInput,
): string {
  const canonical = JSON.stringify({
    studentId: input.studentId,
    documentType: input.documentType,
    qualificationId: input.qualificationId,
    originalFileName: input.originalFileName,
    byteSize: input.byteSize,
    contentSha256: input.contentSha256,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function buildDocumentOrderBy(
  sortBy: DocumentSortField | undefined,
  sortOrder: SortDirection | undefined,
): Prisma.DocumentOrderByWithRelationInput[] {
  const field = sortBy ?? 'uploadedAt';
  if (!DOCUMENT_SORT_FIELDS.includes(field)) {
    throw validationError('sortBy', 'Unsupported sortBy field');
  }
  const direction = sortOrder ?? (sortBy === undefined ? 'desc' : 'asc');
  if (direction !== 'asc' && direction !== 'desc') {
    throw validationError('sortOrder', 'sortOrder must be asc or desc');
  }
  if (field === 'id') {
    return [{ id: direction }];
  }
  return [{ [field]: direction }, { id: 'asc' }];
}

export function documentArchivedError(
  message = 'Archived document must be restored before editing',
): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.DOCUMENT_ARCHIVED,
    message,
  );
}

export function documentAlreadyArchivedError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.DOCUMENT_ALREADY_ARCHIVED,
    'Document record is already archived',
  );
}

export function documentNotArchivedError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.DOCUMENT_NOT_ARCHIVED,
    'Document record is not archived',
  );
}

export function documentDeletePendingError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.DOCUMENT_DELETE_PENDING,
    'Document deletion is currently pending',
  );
}

export function documentDeletedError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.DOCUMENT_DELETED,
    'Document file has been permanently deleted',
  );
}

export function documentQualificationMismatchError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.DOCUMENT_QUALIFICATION_STUDENT_MISMATCH,
    'Qualification must belong to the document owning student',
  );
}

export function documentSelectedAsPhotoError(message: string): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.DOCUMENT_SELECTED_AS_PHOTO,
    message,
  );
}

export function invalidDocumentTypeForMimeError(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.INVALID_DOCUMENT_TYPE_FOR_MIME,
    'PERSONAL_PHOTO documents require a JPEG or PNG image file',
  );
}

export function idempotencyKeyConflictError(
  message = 'Idempotency-Key was already used for a different upload request',
): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
    message,
  );
}

export function uploadInterruptedError(
  message = 'Upload operation was interrupted before publication',
): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    ERROR_CODES.UPLOAD_INTERRUPTED,
    message,
  );
}
