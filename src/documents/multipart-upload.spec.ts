import type { IncomingMessage } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { ERROR_CODES } from '../common/errors/error-codes';
import { DocumentType } from '../generated/prisma/client';
import {
  createBufferUploadSource,
  createMultipartUploadSource,
  createSupervisorBufferUploadSource,
  createSupervisorMultipartUploadSource,
} from './multipart-upload';

function buildMultipartRequest(
  parts: ReadonlyArray<
    | { readonly name: string; readonly value: string }
    | {
        readonly name: string;
        readonly filename: string;
        readonly contentType?: string;
        readonly data: Buffer;
      }
  >,
  boundary = '----TestBoundary123456',
): IncomingMessage {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    if ('value' in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
          'utf8',
        ),
      );
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
          'utf8',
        ),
      );
      chunks.push(part.data);
      chunks.push(Buffer.from('\r\n', 'utf8'));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  const body = Buffer.concat(chunks);
  const stream = new PassThrough() as unknown as IncomingMessage & PassThrough;
  stream.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
  };
  stream.end(body);
  return stream;
}

describe('multipart upload receiver and buffer upload source', () => {
  it('streams buffer/readable sources with backpressure, SHA-256, and maxBytes enforcement', async () => {
    const payload = Buffer.from('hello-stream-world', 'utf8');
    const source = createBufferUploadSource({
      documentType: DocumentType.TRANSCRIPT,
      qualificationId: 5,
      originalFileName: 'C:\\docs\\transcript.pdf',
      content: Readable.from([payload.subarray(0, 6), payload.subarray(6)]),
    });

    const receivedChunks: Buffer[] = [];
    const meta = await source.streamToStaging(async (chunk) => {
      await Promise.resolve();
      receivedChunks.push(chunk);
    }, 1024);

    expect(Buffer.concat(receivedChunks)).toEqual(payload);
    expect(meta).toMatchObject({
      documentType: DocumentType.TRANSCRIPT,
      qualificationId: 5,
      originalFileName: 'transcript.pdf',
      byteSize: payload.length,
    });
    expect(meta.contentSha256).toMatch(/^[0-9a-f]{64}$/);

    const hashOnly = await createBufferUploadSource({
      documentType: DocumentType.TRANSCRIPT,
      qualificationId: 5,
      originalFileName: 'transcript.pdf',
      content: payload,
    }).hashWithoutStoring(1024);
    expect(hashOnly.contentSha256).toBe(meta.contentSha256);

    const noopWrite = () => Promise.resolve();

    await expect(
      createBufferUploadSource({
        documentType: DocumentType.OTHER,
        originalFileName: 'big.pdf',
        content: payload,
      }).streamToStaging(noopWrite, payload.length - 1),
    ).rejects.toMatchObject({ code: ERROR_CODES.FILE_TOO_LARGE });
  });

  it('parses multipart fields in any order, preserves UTF-8 Arabic filenames, and hashes identically without storing', async () => {
    const fileData = Buffer.from('PDF-content-bytes-123456', 'utf8');
    const req1 = buildMultipartRequest([
      {
        name: 'file',
        filename: 'شهادة التخرج.pdf',
        contentType: 'application/pdf',
        data: fileData,
      },
      { name: 'documentType', value: DocumentType.BACHELOR_CERTIFICATE },
      { name: 'qualificationId', value: '12' },
    ]);

    const stagedChunks: Buffer[] = [];
    const result1 = await createMultipartUploadSource(req1).streamToStaging(
      async (chunk) => {
        await Promise.resolve();
        stagedChunks.push(chunk);
      },
      1024,
    );
    expect(Buffer.concat(stagedChunks)).toEqual(fileData);
    expect(result1).toMatchObject({
      documentType: DocumentType.BACHELOR_CERTIFICATE,
      qualificationId: 12,
      originalFileName: 'شهادة التخرج.pdf',
      byteSize: fileData.length,
    });

    const req2 = buildMultipartRequest([
      { name: 'documentType', value: DocumentType.BACHELOR_CERTIFICATE },
      { name: 'qualificationId', value: '12' },
      {
        name: 'file',
        filename: 'شهادة التخرج.pdf',
        contentType: 'application/pdf',
        data: fileData,
      },
    ]);
    const result2 =
      await createMultipartUploadSource(req2).hashWithoutStoring(1024);
    expect(result2).toEqual(result1);
  });

  it('rejects missing multipart header, missing file, unknown fields, and extra files', async () => {
    const noopWrite = () => Promise.resolve();
    const notMultipart = new PassThrough() as unknown as IncomingMessage &
      PassThrough;
    notMultipart.headers = { 'content-type': 'application/json' };
    notMultipart.end('{}');

    await expect(
      createMultipartUploadSource(notMultipart).streamToStaging(
        noopWrite,
        1024,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    const missingFile = buildMultipartRequest([
      { name: 'documentType', value: DocumentType.NATIONAL_ID },
    ]);
    await expect(
      createMultipartUploadSource(missingFile).streamToStaging(noopWrite, 1024),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    const unknownField = buildMultipartRequest([
      { name: 'documentType', value: DocumentType.NATIONAL_ID },
      { name: 'extra', value: 'bad' },
      { name: 'file', filename: 'id.png', data: Buffer.from('abc') },
    ]);
    await expect(
      createMultipartUploadSource(unknownField).streamToStaging(
        noopWrite,
        1024,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    const wrongFileField = buildMultipartRequest([
      { name: 'documentType', value: DocumentType.NATIONAL_ID },
      { name: 'attachment', filename: 'id.png', data: Buffer.from('abc') },
    ]);
    await expect(
      createMultipartUploadSource(wrongFileField).streamToStaging(
        noopWrite,
        1024,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
  });

  it('rejects oversized multipart streams cleanly with FILE_TOO_LARGE', async () => {
    const req = buildMultipartRequest([
      { name: 'documentType', value: DocumentType.OTHER },
      { name: 'file', filename: 'huge.pdf', data: Buffer.alloc(2048, 0x41) },
    ]);

    await expect(
      createMultipartUploadSource(req).streamToStaging(
        () => Promise.resolve(),
        512,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.FILE_TOO_LARGE });
  });

  it('supports supervisor multipart and buffer uploads with optional description and generic category', async () => {
    const fileData = Buffer.from('supervisor-cv-bytes', 'utf8');
    const req = buildMultipartRequest([
      { name: 'description', value: '  Approved external supervision CV  ' },
      { name: 'file', filename: 'cv.pdf', data: fileData },
    ]);

    const result = await createSupervisorMultipartUploadSource(
      req,
    ).streamToStaging(() => Promise.resolve(), 1024);
    expect(result).toMatchObject({
      documentType: DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT,
      qualificationId: null,
      description: 'Approved external supervision CV',
      originalFileName: 'cv.pdf',
      byteSize: fileData.length,
    });

    const badQualReq = buildMultipartRequest([
      { name: 'qualificationId', value: '1' },
      { name: 'file', filename: 'cv.pdf', data: fileData },
    ]);
    await expect(
      createSupervisorMultipartUploadSource(badQualReq).streamToStaging(
        () => Promise.resolve(),
        1024,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    const buffered = await createSupervisorBufferUploadSource({
      originalFileName: 'supporting.pdf',
      content: fileData,
    }).hashWithoutStoring(1024);
    expect(buffered).toMatchObject({
      documentType: DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT,
      qualificationId: null,
      description: null,
    });
  });
});
