import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import { DocumentType } from '../generated/prisma/client';
import {
  STUDENT_DOCUMENT_TYPES,
  buildContentDisposition,
  buildDocumentOrderBy,
  computeUploadRequestFingerprint,
  parseMultipartDescription,
  sanitizeOriginalFileName,
  validateDocumentDisposition,
  validateDocumentType,
  validateIdempotencyKey,
  validateOptionalDocumentDescription,
  validateStudentDocumentType,
  validateSupervisorDocumentType,
} from './documents.validation';

function expectApiErrorCode(fn: () => unknown, expectedCode: string): void {
  try {
    fn();
    throw new Error(`Expected ApiError(${expectedCode}), but succeeded`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(expectedCode);
  }
}

describe('documents validation', () => {
  it('validates all approved DocumentType categories and separates student vs supervisor types', () => {
    for (const value of Object.values(DocumentType)) {
      expect(validateDocumentType(value)).toBe(value);
    }
    for (const value of STUDENT_DOCUMENT_TYPES) {
      expect(validateStudentDocumentType(value)).toBe(value);
    }
    expectApiErrorCode(
      () =>
        validateStudentDocumentType(
          DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT,
        ),
      ERROR_CODES.VALIDATION_ERROR,
    );
    expect(validateSupervisorDocumentType(undefined)).toBe(
      DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT,
    );
    expect(
      validateSupervisorDocumentType(
        DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT,
      ),
    ).toBe(DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT);
    expectApiErrorCode(
      () => validateSupervisorDocumentType(DocumentType.OTHER),
      ERROR_CODES.VALIDATION_ERROR,
    );
    expectApiErrorCode(
      () => validateDocumentType('INVALID_TYPE' as DocumentType),
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('validates optional supervisor document descriptions', () => {
    expect(validateOptionalDocumentDescription(undefined)).toBeUndefined();
    expect(validateOptionalDocumentDescription(null)).toBeNull();
    expect(validateOptionalDocumentDescription('  External CV  ')).toBe(
      'External CV',
    );
    expect(parseMultipartDescription(undefined)).toBeNull();
    expect(parseMultipartDescription('  Approval memo  ')).toBe(
      'Approval memo',
    );
    expectApiErrorCode(
      () => parseMultipartDescription('   '),
      ERROR_CODES.VALIDATION_ERROR,
    );
    expectApiErrorCode(
      () => validateOptionalDocumentDescription('a'.repeat(501)),
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('validates and trims idempotency keys and rejects blank, control-char, or oversized keys', () => {
    expect(validateIdempotencyKey('  upload-key-123  ')).toBe('upload-key-123');
    for (const bad of [
      undefined,
      '',
      '   ',
      'a'.repeat(129),
      'bad\nkey',
      'bad\0key',
      123,
    ]) {
      expectApiErrorCode(
        () => validateIdempotencyKey(bad),
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
  });

  it('sanitizes original filenames while preserving UTF-8 and stripping directory paths', () => {
    expect(sanitizeOriginalFileName('C:\\Users\\ahm\\شهادة التخرج.pdf')).toBe(
      'شهادة التخرج.pdf',
    );
    expect(sanitizeOriginalFileName('../../secret/transcript.pdf')).toBe(
      'transcript.pdf',
    );
    expect(sanitizeOriginalFileName('  photo.png  ')).toBe('photo.png');

    for (const bad of [
      '',
      '   ',
      '.',
      '..',
      'dir/',
      'bad\nname.pdf',
      'a'.repeat(256),
    ]) {
      expectApiErrorCode(
        () => sanitizeOriginalFileName(bad),
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
  });

  it('builds safe Content-Disposition headers and forces Office documents to download as attachments', () => {
    const docxHeader = buildContentDisposition(
      'نموذج; "اختبار".docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'inline',
    );
    expect(docxHeader.startsWith('attachment;')).toBe(true);
    expect(docxHeader).toContain('filename="');
    expect(docxHeader).toContain("filename*=UTF-8''");
    expect(docxHeader).not.toMatch(/[\r\n]/);

    const xlsxHeader = buildContentDisposition(
      'grades.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'inline',
    );
    expect(xlsxHeader.startsWith('attachment;')).toBe(true);

    const pdfInline = buildContentDisposition(
      'transcript.pdf',
      'application/pdf',
      'inline',
    );
    expect(pdfInline).toBe(
      'inline; filename="transcript.pdf"; filename*=UTF-8\'\'transcript.pdf',
    );

    const pngDefault = buildContentDisposition('صورة.png', 'image/png');
    expect(pngDefault.startsWith('attachment;')).toBe(true);
    expect(pngDefault).toContain('filename="document.png"');
  });

  it('validates disposition and builds deterministic sorting with id tie-breaker', () => {
    expect(validateDocumentDisposition(undefined)).toBe('attachment');
    expect(validateDocumentDisposition('inline')).toBe('inline');
    expectApiErrorCode(
      () => validateDocumentDisposition('open' as 'attachment'),
      ERROR_CODES.VALIDATION_ERROR,
    );

    expect(buildDocumentOrderBy(undefined, undefined)).toEqual([
      { uploadedAt: 'desc' },
      { id: 'asc' },
    ]);
    expect(buildDocumentOrderBy('id', 'desc')).toEqual([{ id: 'desc' }]);
    expect(buildDocumentOrderBy('originalFileName', 'asc')).toEqual([
      { originalFileName: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('computes deterministic 64-hex request fingerprints sensitive to every upload attribute', () => {
    const base = {
      studentId: 10,
      supervisorId: null,
      documentType: DocumentType.TRANSCRIPT,
      qualificationId: 3,
      description: null,
      originalFileName: 'transcript.pdf',
      byteSize: 1024,
      contentSha256: 'a'.repeat(64),
    };
    const fp1 = computeUploadRequestFingerprint(base);
    const fp2 = computeUploadRequestFingerprint({ ...base });
    const fp3 = computeUploadRequestFingerprint({
      ...base,
      qualificationId: null,
    });
    const fp4 = computeUploadRequestFingerprint({
      ...base,
      documentType: DocumentType.OTHER,
    });
    const fp5 = computeUploadRequestFingerprint({
      ...base,
      studentId: null,
      supervisorId: 10,
      qualificationId: null,
      documentType: DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT,
      description: 'CV',
    });

    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);
    expect(fp1).not.toBe(fp4);
    expect(fp1).not.toBe(fp5);
  });
});
