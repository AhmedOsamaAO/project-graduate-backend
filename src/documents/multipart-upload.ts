import { HttpStatus } from '@nestjs/common';
import busboy from 'busboy';
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { DocumentType } from '../generated/prisma/client';
import { validationError } from '../students/students.validation';
import {
  parseMultipartDescription,
  parseMultipartQualificationId,
  sanitizeOriginalFileName,
  uploadInterruptedError,
  validateOptionalDocumentDescription,
  validateOptionalQualificationId,
  validateStudentDocumentType,
  validateSupervisorDocumentType,
} from './documents.validation';

export interface ReceivedUploadFile {
  readonly documentType: DocumentType;
  readonly qualificationId: number | null;
  readonly description: string | null;
  readonly originalFileName: string;
  readonly byteSize: number;
  readonly contentSha256: string;
}

export interface UploadSource {
  streamToStaging(
    writeChunk: (chunk: Buffer) => Promise<void>,
    maxBytes: number,
  ): Promise<ReceivedUploadFile>;
  hashWithoutStoring(maxBytes: number): Promise<ReceivedUploadFile>;
}

export interface BufferUploadSourceInput {
  readonly documentType: DocumentType;
  readonly qualificationId?: number | null;
  readonly originalFileName: string;
  readonly content: Buffer | Readable;
}

export interface SupervisorBufferUploadSourceInput {
  readonly documentType?: DocumentType;
  readonly description?: string | null;
  readonly originalFileName: string;
  readonly content: Buffer | Readable;
}

type MultipartUploadMode = 'STUDENT' | 'SUPERVISOR';

const MAX_MULTIPART_FIELDS = 10;
const MAX_MULTIPART_FIELD_BYTES = 16 * 1024;

export function createBufferUploadSource(
  input: BufferUploadSourceInput,
): UploadSource {
  const documentType = validateStudentDocumentType(input.documentType);
  const qualificationId =
    validateOptionalQualificationId(input.qualificationId) ?? null;
  const originalFileName = sanitizeOriginalFileName(input.originalFileName);

  return buildBufferedUploadSource({
    documentType,
    qualificationId,
    description: null,
    originalFileName,
    content: input.content,
  });
}

export function createSupervisorBufferUploadSource(
  input: SupervisorBufferUploadSourceInput,
): UploadSource {
  const documentType = validateSupervisorDocumentType(input.documentType);
  const description =
    validateOptionalDocumentDescription(input.description) ?? null;
  const originalFileName = sanitizeOriginalFileName(input.originalFileName);

  return buildBufferedUploadSource({
    documentType,
    qualificationId: null,
    description,
    originalFileName,
    content: input.content,
  });
}

function buildBufferedUploadSource(input: {
  readonly documentType: DocumentType;
  readonly qualificationId: number | null;
  readonly description: string | null;
  readonly originalFileName: string;
  readonly content: Buffer | Readable;
}): UploadSource {
  const consume = async (
    maxBytes: number,
    writeChunk?: (chunk: Buffer) => Promise<void>,
  ): Promise<ReceivedUploadFile> => {
    const hash = createHash('sha256');
    let byteSize = 0;

    if (Buffer.isBuffer(input.content)) {
      byteSize = input.content.length;
      if (byteSize > maxBytes) {
        throw fileTooLargeError(maxBytes);
      }
      hash.update(input.content);
      if (writeChunk && byteSize > 0) {
        await writeChunk(input.content);
      }
    } else {
      for await (const rawChunk of input.content) {
        const chunk = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk as Uint8Array);
        byteSize += chunk.length;
        if (byteSize > maxBytes) {
          input.content.destroy();
          throw fileTooLargeError(maxBytes);
        }
        hash.update(chunk);
        if (writeChunk && chunk.length > 0) {
          await writeChunk(chunk);
        }
      }
    }

    return {
      documentType: input.documentType,
      qualificationId: input.qualificationId,
      description: input.description,
      originalFileName: input.originalFileName,
      byteSize,
      contentSha256: hash.digest('hex'),
    };
  };

  return {
    streamToStaging: (writeChunk, maxBytes) => consume(maxBytes, writeChunk),
    hashWithoutStoring: (maxBytes) => consume(maxBytes),
  };
}

export function createMultipartUploadSource(
  req: IncomingMessage,
): UploadSource {
  return {
    streamToStaging: (writeChunk, maxBytes) =>
      consumeMultipartRequest(req, maxBytes, 'STUDENT', writeChunk),
    hashWithoutStoring: (maxBytes) =>
      consumeMultipartRequest(req, maxBytes, 'STUDENT'),
  };
}

export function createSupervisorMultipartUploadSource(
  req: IncomingMessage,
): UploadSource {
  return {
    streamToStaging: (writeChunk, maxBytes) =>
      consumeMultipartRequest(req, maxBytes, 'SUPERVISOR', writeChunk),
    hashWithoutStoring: (maxBytes) =>
      consumeMultipartRequest(req, maxBytes, 'SUPERVISOR'),
  };
}

async function consumeMultipartRequest(
  req: IncomingMessage,
  maxBytes: number,
  mode: MultipartUploadMode,
  writeChunk?: (chunk: Buffer) => Promise<void>,
): Promise<ReceivedUploadFile> {
  const contentType = req.headers['content-type'];
  if (
    typeof contentType !== 'string' ||
    !/^multipart\/form-data\b/i.test(contentType)
  ) {
    throw validationError(
      'contentType',
      'Request Content-Type must be multipart/form-data',
    );
  }

  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      limits: {
        files: 1,
        fields: MAX_MULTIPART_FIELDS,
        fieldSize: MAX_MULTIPART_FIELD_BYTES,
        fileSize: maxBytes,
      },
    });
  } catch {
    throw validationError(
      'contentType',
      'Invalid multipart/form-data request header',
    );
  }

  const fields = new Map<string, string>();
  const hash = createHash('sha256');
  const filePromises: Array<Promise<void>> = [];

  const uploadState: {
    firstError: Error | null;
    sawFile: boolean;
    rawFileName: string | undefined;
    byteSize: number;
  } = {
    firstError: null,
    sawFile: false,
    rawFileName: undefined,
    byteSize: 0,
  };

  const recordError = (err: unknown) => {
    uploadState.firstError ??=
      err instanceof Error ? err : new Error('Multipart upload failed');
  };

  parser.on('field', (name, value, info) => {
    if (info.nameTruncated || info.valueTruncated) {
      recordError(
        validationError(name || 'field', 'Multipart field too large'),
      );
      return;
    }
    const allowedField =
      mode === 'STUDENT'
        ? name === 'documentType' || name === 'qualificationId'
        : name === 'documentType' || name === 'description';
    if (!allowedField) {
      recordError(
        validationError(name, `Unexpected multipart field "${name}"`),
      );
      return;
    }
    if (fields.has(name)) {
      recordError(validationError(name, `Duplicate multipart field "${name}"`));
      return;
    }
    fields.set(name, value);
  });

  parser.on('file', (name, fileStream, info) => {
    if (name !== 'file') {
      recordError(
        validationError(
          name || 'file',
          `Unexpected file field "${name}"; expected "file"`,
        ),
      );
      fileStream.resume();
      return;
    }
    if (uploadState.sawFile) {
      recordError(validationError('file', 'Only one file may be uploaded'));
      fileStream.resume();
      return;
    }
    uploadState.sawFile = true;
    uploadState.rawFileName = info.filename;

    fileStream.on('limit', () => {
      recordError(fileTooLargeError(maxBytes));
    });

    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (uploadState.firstError) {
          callback();
          return;
        }
        uploadState.byteSize += chunk.length;
        if (uploadState.byteSize > maxBytes) {
          recordError(fileTooLargeError(maxBytes));
          callback();
          return;
        }
        hash.update(chunk);
        if (!writeChunk || chunk.length === 0) {
          callback();
          return;
        }
        writeChunk(chunk).then(
          () => callback(),
          (error: unknown) => {
            recordError(
              error instanceof Error
                ? error
                : new Error('Staging write failed'),
            );
            callback();
          },
        );
      },
    });

    const done = new Promise<void>((resolve) => {
      sink.once('finish', resolve);
      sink.once('error', (error: unknown) => {
        recordError(error);
        fileStream.resume();
        resolve();
      });
      fileStream.once('error', (error: unknown) => {
        recordError(error);
        sink.destroy();
        resolve();
      });
    });

    filePromises.push(done);
    fileStream.pipe(sink);
  });

  parser.on('fieldsLimit', () => {
    recordError(validationError('fields', 'Too many multipart fields'));
  });
  parser.on('filesLimit', () => {
    recordError(validationError('file', 'Only one file may be uploaded'));
  });
  parser.on('partsLimit', () => {
    recordError(validationError('parts', 'Too many multipart parts'));
  });

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    req.once('aborted', () => {
      recordError(
        uploadInterruptedError('Upload request aborted before completion'),
      );
      parser.destroy();
      finish();
    });
    req.once('error', () => {
      recordError(
        uploadInterruptedError(
          'Upload request stream failed before completion',
        ),
      );
      parser.destroy();
      finish();
    });
    parser.once('error', (error: unknown) => {
      if (!uploadState.firstError) {
        recordError(
          error instanceof ApiError
            ? error
            : validationError('multipart', 'Malformed multipart upload body'),
        );
      }
      finish();
    });
    parser.once('close', finish);

    req.pipe(parser);
  });

  await Promise.all(filePromises);

  if (uploadState.firstError !== null) {
    throw uploadState.firstError;
  }
  if (!uploadState.sawFile) {
    throw validationError('file', 'Multipart file field "file" is required');
  }

  const rawDocumentType = fields.get('documentType');
  let documentType: DocumentType;
  let qualificationId: number | null;
  let description: string | null;

  if (mode === 'STUDENT') {
    if (rawDocumentType === undefined) {
      throw validationError('documentType', 'documentType is required');
    }
    documentType = validateStudentDocumentType(rawDocumentType as DocumentType);
    qualificationId = parseMultipartQualificationId(
      fields.get('qualificationId'),
    );
    description = null;
  } else {
    documentType = validateSupervisorDocumentType(
      rawDocumentType as DocumentType | undefined,
    );
    qualificationId = null;
    description = parseMultipartDescription(fields.get('description'));
  }

  const originalFileName = sanitizeOriginalFileName(
    uploadState.rawFileName ?? '',
  );

  return {
    documentType,
    qualificationId,
    description,
    originalFileName,
    byteSize: uploadState.byteSize,
    contentSha256: hash.digest('hex'),
  };
}

function fileTooLargeError(maxBytes: number): ApiError {
  return new ApiError(
    HttpStatus.BAD_REQUEST,
    ERROR_CODES.FILE_TOO_LARGE,
    `Uploaded file exceeds the maximum allowed size of ${maxBytes} bytes`,
  );
}
