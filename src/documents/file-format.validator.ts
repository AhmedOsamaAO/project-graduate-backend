import { HttpStatus } from '@nestjs/common';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { posix as pathPosix } from 'node:path';
import { crc32, createInflateRaw } from 'node:zlib';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { DocumentType } from '../generated/prisma/client';

export const SUPPORTED_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

export type SupportedDocumentMimeType =
  (typeof SUPPORTED_DOCUMENT_MIME_TYPES)[number];

export const PERSONAL_PHOTO_MIME_TYPES: ReadonlySet<SupportedDocumentMimeType> =
  new Set(['image/jpeg', 'image/png']);

export const OFFICE_ATTACHMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export interface ValidatedFileFormat {
  readonly mimeType: SupportedDocumentMimeType;
  readonly byteSize: number;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const OLE2_SIGNATURE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);
const ZIP_LFH_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const MAX_IMAGE_DIMENSION = 50_000;
const CHUNK_READ_BYTES = 64 * 1024;

const PNG_VALID_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const DOCX_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const XLSX_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const OOXML_CONTENT_TYPES_NS =
  'http://schemas.openxmlformats.org/package/2006/content-types';
const OOXML_RELS_NS =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_DOC_REL_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
]);
const WORKSHEET_REL_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet',
]);
const WORD_MAIN_NS = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const SHEET_MAIN_NS = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);

const MAX_ZIP_ENTRIES = 2000;
const MAX_ZIP_CD_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024;
const MAX_ZIP_RATIO = 100;
const MIN_ZIP_RATIO_FLOOR = 2 * 1024 * 1024;
const MAX_XML_ENTRY_BYTES = 2 * 1024 * 1024;

function unsupportedFormatError(message: string): ApiError {
  return new ApiError(
    HttpStatus.BAD_REQUEST,
    ERROR_CODES.UNSUPPORTED_FILE_FORMAT,
    message,
  );
}

/**
 * Inspects actual staged file contents (never trusting client filename or MIME)
 * and rejects legacy Office, macro-enabled, corrupt, oversized, or disallowed formats.
 */
export async function validateFileFormat(
  filePath: string,
  documentType: DocumentType,
  maxBytes: number,
): Promise<ValidatedFileFormat> {
  const linkStat = await lstat(filePath).catch(() => null);
  if (!linkStat || linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw unsupportedFormatError('Uploaded file is not a regular file');
  }

  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, openFlags).catch(() => null);
  if (!handle) {
    throw unsupportedFormatError('Uploaded file could not be read');
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw unsupportedFormatError('Uploaded file is not a regular file');
    }
    if (stat.size <= 0) {
      throw unsupportedFormatError('Uploaded file must not be empty');
    }
    if (stat.size > maxBytes) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        ERROR_CODES.FILE_TOO_LARGE,
        `Uploaded file exceeds the maximum allowed size of ${maxBytes} bytes`,
      );
    }

    const head = await readExactRange(handle, 0, Math.min(16, stat.size));
    let mimeType: SupportedDocumentMimeType;

    if (head.length >= 8 && head.subarray(0, 8).equals(OLE2_SIGNATURE)) {
      throw unsupportedFormatError(
        'Legacy binary Office formats are not supported',
      );
    } else if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) {
      await validatePng(handle, stat.size);
      mimeType = 'image/png';
    } else if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) {
      await validateJpeg(handle, stat.size);
      mimeType = 'image/jpeg';
    } else if (
      head.length >= 5 &&
      head.subarray(0, 5).toString('ascii') === '%PDF-'
    ) {
      await validatePdf(handle, stat.size);
      mimeType = 'application/pdf';
    } else if (
      head.length >= 4 &&
      head.subarray(0, 4).equals(ZIP_LFH_SIGNATURE)
    ) {
      mimeType = await validateOoxmlPackage(handle, stat.size);
    } else {
      throw unsupportedFormatError(
        'File format must be PDF, JPEG, PNG, DOCX, or XLSX',
      );
    }

    if (
      documentType === 'PERSONAL_PHOTO' &&
      !PERSONAL_PHOTO_MIME_TYPES.has(mimeType)
    ) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        ERROR_CODES.INVALID_PERSONAL_PHOTO_FORMAT,
        'Personal photos must be JPEG or PNG images',
      );
    }

    return { mimeType, byteSize: stat.size };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readExactRange(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  if (length === 0) {
    return Buffer.alloc(0);
  }
  const buffer = Buffer.alloc(length);
  let totalRead = 0;
  while (totalRead < length) {
    const { bytesRead } = await handle.read(
      buffer,
      totalRead,
      length - totalRead,
      position + totalRead,
    );
    if (bytesRead === 0) {
      throw unsupportedFormatError('Unexpected end of file');
    }
    totalRead += bytesRead;
  }
  return buffer;
}

async function validatePng(
  handle: FileHandle,
  fileSize: number,
): Promise<void> {
  let offset = 8;
  let chunkIndex = 0;
  let sawIdat = false;
  let sawIend = false;

  while (offset < fileSize) {
    if (offset + 12 > fileSize) {
      throw unsupportedFormatError('Truncated PNG chunk');
    }
    const header = await readExactRange(handle, offset, 8);
    const length = header.readUInt32BE(0);
    const typeBuf = header.subarray(4, 8);
    const type = typeBuf.toString('ascii');

    if (
      length > 0x7fffffff ||
      !/^[A-Za-z]{4}$/.test(type) ||
      offset + 12 + length > fileSize
    ) {
      throw unsupportedFormatError('Invalid PNG chunk structure');
    }
    if (chunkIndex === 0 && type !== 'IHDR') {
      throw unsupportedFormatError('PNG must start with IHDR chunk');
    }

    let runningCrc = crc32(typeBuf);
    if (type === 'IHDR') {
      if (length !== 13) {
        throw unsupportedFormatError('Invalid PNG IHDR chunk length');
      }
      const ihdr = await readExactRange(handle, offset + 8, 13);
      validatePngIhdr(ihdr);
      runningCrc = crc32(ihdr, runningCrc);
    } else {
      let remaining = length;
      let cursor = offset + 8;
      while (remaining > 0) {
        const toRead = Math.min(remaining, CHUNK_READ_BYTES);
        const slice = await readExactRange(handle, cursor, toRead);
        runningCrc = crc32(slice, runningCrc);
        cursor += toRead;
        remaining -= toRead;
      }
    }

    const expectedCrcBuf = await readExactRange(handle, offset + 8 + length, 4);
    const expectedCrc = expectedCrcBuf.readUInt32BE(0);
    if (runningCrc >>> 0 !== expectedCrc) {
      throw unsupportedFormatError('Corrupt PNG chunk checksum');
    }

    if (type === 'IDAT' && length > 0) {
      sawIdat = true;
    }

    offset += 12 + length;
    chunkIndex += 1;

    if (type === 'IEND') {
      if (length !== 0 || offset !== fileSize) {
        throw unsupportedFormatError('Invalid PNG IEND trailer');
      }
      sawIend = true;
      break;
    }
  }

  if (!sawIdat || !sawIend) {
    throw unsupportedFormatError('Incomplete PNG image stream');
  }
}

function validatePngIhdr(ihdr: Buffer): void {
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const compression = ihdr[10];
  const filter = ihdr[11];
  const interlace = ihdr[12];

  if (
    width < 1 ||
    width > MAX_IMAGE_DIMENSION ||
    height < 1 ||
    height > MAX_IMAGE_DIMENSION
  ) {
    throw unsupportedFormatError('Invalid PNG image dimensions');
  }
  const allowedDepths = PNG_VALID_BIT_DEPTHS[colorType];
  if (!allowedDepths?.includes(bitDepth)) {
    throw unsupportedFormatError('Invalid PNG color type or bit depth');
  }
  if (
    compression !== 0 ||
    filter !== 0 ||
    (interlace !== 0 && interlace !== 1)
  ) {
    throw unsupportedFormatError('Invalid PNG header parameters');
  }
}

async function validateJpeg(
  handle: FileHandle,
  fileSize: number,
): Promise<void> {
  if (fileSize < 4) {
    throw unsupportedFormatError('Truncated JPEG image');
  }

  let offset = 2;
  let sawSof = false;
  let sawSos = false;
  let pendingMarker: number | null = null;

  while (pendingMarker !== null || offset < fileSize) {
    let marker: number;
    if (pendingMarker !== null) {
      marker = pendingMarker;
      pendingMarker = null;
    } else {
      const markerRead = await readNextJpegMarker(handle, fileSize, offset);
      marker = markerRead.marker;
      offset = markerRead.nextOffset;
    }

    if (marker === 0x00 || marker === 0xd8) {
      throw unsupportedFormatError('Invalid JPEG marker stream');
    }
    if (marker === 0xd9) {
      if (!sawSof || !sawSos || offset !== fileSize) {
        throw unsupportedFormatError('Incomplete or trailing JPEG image');
      }
      return;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (offset + 2 > fileSize) {
      throw unsupportedFormatError('Truncated JPEG segment length');
    }
    const lenBuf = await readExactRange(handle, offset, 2);
    const segmentLength = lenBuf.readUInt16BE(0);
    if (segmentLength < 2 || offset + segmentLength > fileSize) {
      throw unsupportedFormatError('Invalid JPEG segment length');
    }

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) {
        throw unsupportedFormatError('Invalid JPEG SOF segment');
      }
      const sof = await readExactRange(handle, offset + 2, segmentLength - 2);
      const precision = sof[0];
      const height = sof.readUInt16BE(1);
      const width = sof.readUInt16BE(3);
      const components = sof[5];
      if (
        (precision !== 8 && precision !== 12 && precision !== 16) ||
        width < 1 ||
        width > MAX_IMAGE_DIMENSION ||
        height < 1 ||
        height > MAX_IMAGE_DIMENSION ||
        components < 1 ||
        components > 4 ||
        segmentLength !== 8 + components * 3
      ) {
        throw unsupportedFormatError('Invalid JPEG image frame parameters');
      }
      sawSof = true;
      offset += segmentLength;
      continue;
    }

    if (marker === 0xda) {
      if (!sawSof || segmentLength < 6) {
        throw unsupportedFormatError('JPEG SOS marker before valid frame');
      }
      sawSos = true;
      offset += segmentLength;
      const scanResult = await scanJpegEntropyData(handle, fileSize, offset);
      pendingMarker = scanResult.marker;
      offset = scanResult.nextOffset;
      continue;
    }

    offset += segmentLength;
  }

  throw unsupportedFormatError('JPEG image missing EOI marker');
}

async function readNextJpegMarker(
  handle: FileHandle,
  fileSize: number,
  startOffset: number,
): Promise<{ readonly marker: number; readonly nextOffset: number }> {
  let offset = startOffset;
  if (offset >= fileSize) {
    throw unsupportedFormatError('Unexpected end of JPEG stream');
  }
  const first = await readExactRange(handle, offset, 1);
  if (first[0] !== 0xff) {
    throw unsupportedFormatError('Expected JPEG marker prefix');
  }
  while (offset < fileSize) {
    const byteBuf = await readExactRange(handle, offset, 1);
    offset += 1;
    if (byteBuf[0] !== 0xff) {
      return { marker: byteBuf[0], nextOffset: offset };
    }
  }
  throw unsupportedFormatError('Truncated JPEG marker');
}

async function scanJpegEntropyData(
  handle: FileHandle,
  fileSize: number,
  startOffset: number,
): Promise<{ readonly marker: number; readonly nextOffset: number }> {
  let offset = startOffset;
  let sawFf = false;

  while (offset < fileSize) {
    const toRead = Math.min(CHUNK_READ_BYTES, fileSize - offset);
    const chunk = await readExactRange(handle, offset, toRead);

    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index];
      if (!sawFf) {
        if (byte === 0xff) {
          sawFf = true;
        }
        continue;
      }

      if (byte === 0xff) {
        continue;
      }
      if (byte === 0x00 || (byte >= 0xd0 && byte <= 0xd7)) {
        sawFf = false;
        continue;
      }
      return {
        marker: byte,
        nextOffset: offset + index + 1,
      };
    }

    offset += chunk.length;
  }

  throw unsupportedFormatError('JPEG entropy stream missing EOI marker');
}

async function validatePdf(
  handle: FileHandle,
  fileSize: number,
): Promise<void> {
  const headerSlice = await readExactRange(handle, 0, Math.min(32, fileSize));
  const headerText = headerSlice.toString('latin1');
  if (!/^%PDF-(?:1\.[0-7]|2\.[0-9])[\r\n \t]/.test(headerText)) {
    throw unsupportedFormatError('Invalid PDF header');
  }

  const tailSize = Math.min(4096, fileSize);
  const tail = await readExactRange(handle, fileSize - tailSize, tailSize);
  const tailText = tail.toString('latin1');

  const eofMatch = /%%EOF[\r\n \t]*$/.exec(tailText);
  if (!eofMatch) {
    throw unsupportedFormatError('PDF missing %%EOF trailer');
  }

  const beforeEof = tailText.slice(0, eofMatch.index);
  const startXrefMatch = /startxref[\r\n \t]+(\d+)[\r\n \t]+$/.exec(beforeEof);
  if (!startXrefMatch) {
    throw unsupportedFormatError('PDF missing startxref offset');
  }

  const xrefOffset = Number(startXrefMatch[1]);
  if (
    !Number.isSafeInteger(xrefOffset) ||
    xrefOffset < 8 ||
    xrefOffset >= fileSize
  ) {
    throw unsupportedFormatError('Invalid PDF cross-reference offset');
  }

  const probeLen = Math.min(64, fileSize - xrefOffset);
  const xrefProbe = (
    await readExactRange(handle, xrefOffset, probeLen)
  ).toString('latin1');
  const trimmedProbe = xrefProbe.replace(/^[\r\n \t]+/, '');
  if (
    !trimmedProbe.startsWith('xref') &&
    !/^\d+[\r\n \t]+\d+[\r\n \t]+obj\b/.test(trimmedProbe)
  ) {
    throw unsupportedFormatError('Invalid PDF cross-reference table');
  }
}

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

interface ParsedZipDirectory {
  readonly cdOffset: number;
  readonly entriesByLowerPath: ReadonlyMap<string, ZipEntry>;
}

async function validateOoxmlPackage(
  handle: FileHandle,
  fileSize: number,
): Promise<SupportedDocumentMimeType> {
  const directory = await parseZipCentralDirectory(handle, fileSize);

  const contentTypesEntry = directory.entriesByLowerPath.get(
    '[content_types].xml',
  );
  const rootRelsEntry = directory.entriesByLowerPath.get('_rels/.rels');
  if (!contentTypesEntry || !rootRelsEntry) {
    throw unsupportedFormatError(
      'Archive is not a valid DOCX or XLSX Office package',
    );
  }

  const contentTypesXml = await extractBoundedUtf8Xml(
    handle,
    contentTypesEntry,
    directory.cdOffset,
  );
  const contentTypes = parseContentTypesXml(contentTypesXml);

  const rootRelsXml = await extractBoundedUtf8Xml(
    handle,
    rootRelsEntry,
    directory.cdOffset,
  );
  const officeDocTarget = parseOfficeDocumentTarget(rootRelsXml);
  const mainEntry = directory.entriesByLowerPath.get(
    officeDocTarget.toLowerCase(),
  );
  if (!mainEntry) {
    throw unsupportedFormatError('OOXML package missing main document target');
  }

  const resolvedMainContentType = resolvePartContentType(
    contentTypes,
    officeDocTarget,
  );
  const mainXml = await extractBoundedUtf8Xml(
    handle,
    mainEntry,
    directory.cdOffset,
  );

  if (resolvedMainContentType === DOCX_MAIN_CONTENT_TYPE) {
    assertDocxMainXml(mainXml);
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  if (resolvedMainContentType === XLSX_MAIN_CONTENT_TYPE) {
    assertXlsxMainXml(mainXml);
    await assertXlsxWorksheetsValid(handle, directory, officeDocTarget);
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }

  throw unsupportedFormatError(
    'Only non-macro DOCX and XLSX Office packages are supported',
  );
}

async function parseZipCentralDirectory(
  handle: FileHandle,
  fileSize: number,
): Promise<ParsedZipDirectory> {
  if (fileSize < 22) {
    throw unsupportedFormatError('Truncated Office package');
  }

  const searchSize = Math.min(fileSize, 65_557);
  const tailOffset = fileSize - searchSize;
  const tail = await readExactRange(handle, tailOffset, searchSize);

  let eocdOffset = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (
      tail[i] === 0x50 &&
      tail[i + 1] === 0x4b &&
      tail[i + 2] === 0x05 &&
      tail[i + 3] === 0x06
    ) {
      const commentLen = tail.readUInt16LE(i + 20);
      if (tailOffset + i + 22 + commentLen === fileSize) {
        eocdOffset = tailOffset + i;
        break;
      }
    }
  }

  if (eocdOffset === -1) {
    throw unsupportedFormatError('Invalid Office ZIP central directory');
  }

  const eocd = tail.subarray(
    eocdOffset - tailOffset,
    eocdOffset - tailOffset + 22,
  );
  const diskNumber = eocd.readUInt16LE(4);
  const cdDisk = eocd.readUInt16LE(6);
  const entriesOnDisk = eocd.readUInt16LE(8);
  const totalEntries = eocd.readUInt16LE(10);
  const cdSize = eocd.readUInt32LE(12);
  const cdOffset = eocd.readUInt32LE(16);

  if (
    diskNumber !== 0 ||
    cdDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff ||
    totalEntries < 3 ||
    totalEntries > MAX_ZIP_ENTRIES ||
    cdSize < 46 ||
    cdSize > MAX_ZIP_CD_BYTES ||
    cdOffset < 30 ||
    cdOffset + cdSize > eocdOffset
  ) {
    throw unsupportedFormatError('Unsupported or malformed Office ZIP bounds');
  }

  const cdBuffer = await readExactRange(handle, cdOffset, cdSize);
  const entriesByLowerPath = new Map<string, ZipEntry>();
  let cursor = 0;
  let totalDeclaredUncompressed = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > cdBuffer.length) {
      throw unsupportedFormatError('Truncated ZIP central directory entry');
    }
    if (cdBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw unsupportedFormatError('Invalid ZIP central directory signature');
    }

    const flags = cdBuffer.readUInt16LE(cursor + 8);
    const method = cdBuffer.readUInt16LE(cursor + 10);
    const entryCrc = cdBuffer.readUInt32LE(cursor + 16);
    const compressedSize = cdBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = cdBuffer.readUInt32LE(cursor + 24);
    const nameLength = cdBuffer.readUInt16LE(cursor + 28);
    const extraLength = cdBuffer.readUInt16LE(cursor + 30);
    const commentLength = cdBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = cdBuffer.readUInt32LE(cursor + 42);

    if (
      (flags & 0x0001) !== 0 ||
      (method !== 0 && method !== 8) ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      localHeaderOffset + 30 > cdOffset
    ) {
      throw unsupportedFormatError('Unsupported ZIP entry flags or method');
    }

    const nameStart = cursor + 46;
    const nextCursor = nameStart + nameLength + extraLength + commentLength;
    if (nextCursor > cdBuffer.length) {
      throw unsupportedFormatError('Truncated ZIP entry metadata');
    }

    const name = cdBuffer
      .subarray(nameStart, nameStart + nameLength)
      .toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1');
    const normalized = validateZipEntryPath(name);

    totalDeclaredUncompressed += uncompressedSize;
    if (
      totalDeclaredUncompressed > MAX_ZIP_TOTAL_UNCOMPRESSED ||
      (compressedSize === 0 && uncompressedSize > 0) ||
      uncompressedSize >
        Math.max(MIN_ZIP_RATIO_FLOOR, compressedSize * MAX_ZIP_RATIO)
    ) {
      throw unsupportedFormatError('Office archive exceeds safe size limits');
    }

    assertSafeOoxmlEntryName(normalized);

    const lower = normalized.toLowerCase();
    if (entriesByLowerPath.has(lower)) {
      throw unsupportedFormatError('Duplicate ZIP entry path');
    }

    entriesByLowerPath.set(lower, {
      name: normalized,
      method,
      crc32: entryCrc >>> 0,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor = nextCursor;
  }

  if (cursor !== cdBuffer.length) {
    throw unsupportedFormatError('Trailing data in ZIP central directory');
  }

  return { cdOffset, entriesByLowerPath };
}

function validateZipEntryPath(name: string): string {
  if (
    !name ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/')
  ) {
    throw unsupportedFormatError('Unsafe ZIP entry path');
  }
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) {
      throw unsupportedFormatError('Control characters in ZIP entry path');
    }
  }
  const stripped = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!stripped) {
    throw unsupportedFormatError('Empty ZIP entry path');
  }
  const segments = stripped.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw unsupportedFormatError('Path traversal in ZIP entry path');
  }
  return name;
}

function assertSafeOoxmlEntryName(path: string): void {
  const lower = path.toLowerCase();
  const base = pathPosix.basename(lower);
  if (
    base.startsWith('vbaproject') ||
    base === 'vbadata.xml' ||
    lower === 'xl/workbook.bin' ||
    /(^|\/)(?:activex|macrosheets|dialogsheets)(\/|$)/.test(lower)
  ) {
    throw unsupportedFormatError(
      'Macro-enabled or binary Office packages are not supported',
    );
  }
}

async function extractBoundedUtf8Xml(
  handle: FileHandle,
  entry: ZipEntry,
  cdOffset: number,
): Promise<string> {
  if (entry.uncompressedSize > MAX_XML_ENTRY_BYTES) {
    throw unsupportedFormatError(
      'Office XML part exceeds maximum allowed size',
    );
  }

  const lfh = await readExactRange(handle, entry.localHeaderOffset, 30);
  if (lfh.readUInt32LE(0) !== 0x04034b50) {
    throw unsupportedFormatError('Invalid ZIP local file header');
  }
  const lfhNameLen = lfh.readUInt16LE(26);
  const lfhExtraLen = lfh.readUInt16LE(28);
  const dataStart = entry.localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
  if (dataStart + entry.compressedSize > cdOffset) {
    throw unsupportedFormatError(
      'ZIP entry payload overlaps central directory',
    );
  }
  if (entry.compressedSize > MAX_XML_ENTRY_BYTES * 2) {
    throw unsupportedFormatError(
      'Compressed Office XML part exceeds safety limit',
    );
  }

  const compressed = await readExactRange(
    handle,
    dataStart,
    entry.compressedSize,
  );
  const maxActualBytes = Math.min(
    MAX_XML_ENTRY_BYTES,
    Math.max(
      entry.uncompressedSize,
      entry.compressedSize * MAX_ZIP_RATIO,
      65_536,
    ),
  );

  const inflated =
    entry.method === 0
      ? compressed
      : await inflateBoundedRaw(compressed, maxActualBytes);

  if (
    inflated.length !== entry.uncompressedSize ||
    crc32(inflated) >>> 0 !== entry.crc32
  ) {
    throw unsupportedFormatError('Corrupt Office package entry');
  }

  const text = inflated.toString('utf8');
  if (/<!(?:doctype|entity)\b/i.test(text)) {
    throw unsupportedFormatError('Unsafe XML declaration in Office package');
  }
  return text;
}

function inflateBoundedRaw(
  compressed: Buffer,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inflater = createInflateRaw();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const fail = (error: ApiError) => {
      if (settled) {
        return;
      }
      settled = true;
      inflater.destroy();
      reject(error);
    };

    inflater.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        fail(
          unsupportedFormatError('Office package exceeds inflated size bound'),
        );
        return;
      }
      chunks.push(chunk);
    });
    inflater.once('error', () =>
      fail(unsupportedFormatError('Corrupt compressed Office entry')),
    );
    inflater.once('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks, totalBytes));
    });

    inflater.end(compressed);
  });
}

interface ContentTypesMap {
  readonly defaults: ReadonlyMap<string, string>;
  readonly overrides: ReadonlyMap<string, string>;
}

function parseContentTypesXml(xml: string): ContentTypesMap {
  if (
    !xml.includes(OOXML_CONTENT_TYPES_NS) ||
    !/<(?:[a-z0-9_]+:)?Types\b/i.test(xml)
  ) {
    throw unsupportedFormatError('Invalid OOXML [Content_Types].xml');
  }

  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();

  for (const tagMatch of xml.matchAll(
    /<(?:[a-z0-9_]+:)?(Default|Override)\b([^>]*)\/?>/gi,
  )) {
    const kind = tagMatch[1].toLowerCase();
    const attrs = parseXmlAttributes(tagMatch[2]);
    const contentType = attrs.get('ContentType');
    if (contentType && isForbiddenOfficeContentType(contentType)) {
      throw unsupportedFormatError(
        'Macro-enabled or binary Office content types are not supported',
      );
    }

    if (kind === 'default') {
      const ext = attrs.get('Extension')?.toLowerCase();
      if (ext && contentType) {
        defaults.set(ext, contentType);
      }
    } else {
      const partName = attrs.get('PartName');
      if (partName && contentType) {
        const normalized = normalizePackageTarget(partName);
        overrides.set(normalized.toLowerCase(), contentType);
      }
    }
  }

  return { defaults, overrides };
}

function isForbiddenOfficeContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return (
    lower.includes('macroenabled') ||
    lower.includes('vbaproject') ||
    lower.includes('vbadata') ||
    lower.includes('ms-excel.sheet.binary')
  );
}

function resolvePartContentType(
  contentTypes: ContentTypesMap,
  targetPath: string,
): string | undefined {
  const override = contentTypes.overrides.get(targetPath.toLowerCase());
  if (override) {
    return override;
  }
  const dotIndex = targetPath.lastIndexOf('.');
  if (dotIndex === -1) {
    return undefined;
  }
  const ext = targetPath.slice(dotIndex + 1).toLowerCase();
  return contentTypes.defaults.get(ext);
}

interface PackageRelationship {
  readonly type: string;
  readonly target: string;
  readonly targetMode?: string;
}

function parseRelationshipsXml(xml: string): PackageRelationship[] {
  if (
    !xml.includes(OOXML_RELS_NS) ||
    !/<(?:[a-z0-9_]+:)?Relationships\b/i.test(xml)
  ) {
    throw unsupportedFormatError('Invalid OOXML relationships XML');
  }

  const relationships: PackageRelationship[] = [];
  for (const tagMatch of xml.matchAll(
    /<(?:[a-z0-9_]+:)?Relationship\b([^>]*)\/?>/gi,
  )) {
    const attrs = parseXmlAttributes(tagMatch[1]);
    const type = attrs.get('Type');
    const target = attrs.get('Target');
    if (type && target) {
      relationships.push({
        type,
        target,
        targetMode: attrs.get('TargetMode'),
      });
    }
  }
  return relationships;
}

function parseOfficeDocumentTarget(rootRelsXml: string): string {
  const rels = parseRelationshipsXml(rootRelsXml);
  const officeRels = rels.filter((rel) => OFFICE_DOC_REL_TYPES.has(rel.type));
  if (officeRels.length !== 1) {
    throw unsupportedFormatError(
      'Office package must declare exactly one officeDocument relationship',
    );
  }
  const rel = officeRels[0];
  if (rel.targetMode?.toLowerCase() === 'external') {
    throw unsupportedFormatError(
      'External officeDocument targets are not allowed',
    );
  }
  return normalizePackageTarget(rel.target);
}

function assertDocxMainXml(xml: string): void {
  const hasNs = [...WORD_MAIN_NS].some((ns) => xml.includes(ns));
  if (!hasNs || !/<(?:w:)?document\b/.test(xml)) {
    throw unsupportedFormatError('Invalid DOCX main document structure');
  }
}

function assertXlsxMainXml(xml: string): void {
  const hasNs = [...SHEET_MAIN_NS].some((ns) => xml.includes(ns));
  if (!hasNs || !/<(?:[a-z0-9_]+:)?workbook\b/.test(xml)) {
    throw unsupportedFormatError('Invalid XLSX workbook structure');
  }
}

async function assertXlsxWorksheetsValid(
  handle: FileHandle,
  directory: ParsedZipDirectory,
  workbookPath: string,
): Promise<void> {
  const workbookDir = pathPosix.dirname(workbookPath);
  const workbookBase = pathPosix.basename(workbookPath);
  const workbookRelsPath =
    workbookDir === '.'
      ? `_rels/${workbookBase}.rels`
      : `${workbookDir}/_rels/${workbookBase}.rels`;

  const relsEntry = directory.entriesByLowerPath.get(
    workbookRelsPath.toLowerCase(),
  );
  if (!relsEntry) {
    throw unsupportedFormatError('XLSX package missing workbook relationships');
  }

  const relsXml = await extractBoundedUtf8Xml(
    handle,
    relsEntry,
    directory.cdOffset,
  );
  const rels = parseRelationshipsXml(relsXml);

  let worksheetCount = 0;
  for (const rel of rels) {
    const lowerType = rel.type.toLowerCase();
    if (lowerType.includes('vba') || lowerType.includes('macro')) {
      throw unsupportedFormatError('Macro relationships are not supported');
    }
    if (!WORKSHEET_REL_TYPES.has(rel.type)) {
      continue;
    }
    if (rel.targetMode?.toLowerCase() === 'external') {
      throw unsupportedFormatError(
        'External worksheet targets are not allowed',
      );
    }
    const targetPath = resolveRelativePackageTarget(workbookDir, rel.target);
    if (!directory.entriesByLowerPath.has(targetPath.toLowerCase())) {
      throw unsupportedFormatError('XLSX references a missing worksheet part');
    }
    worksheetCount += 1;
  }

  if (worksheetCount < 1) {
    throw unsupportedFormatError(
      'XLSX workbook must contain at least one worksheet',
    );
  }
}

function normalizePackageTarget(rawTarget: string): string {
  const cleaned = rawTarget.replace(/^\/+/, '');
  const normalized = pathPosix.normalize(cleaned);
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('\\')
  ) {
    throw unsupportedFormatError('Unsafe OOXML relationship target');
  }
  return normalized;
}

function resolveRelativePackageTarget(baseDir: string, target: string): string {
  if (target.startsWith('/')) {
    return normalizePackageTarget(target);
  }
  const joined = baseDir === '.' ? target : `${baseDir}/${target}`;
  return normalizePackageTarget(joined);
}

function parseXmlAttributes(rawAttrs: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of rawAttrs.matchAll(
    /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    attrs.set(match[1], match[2] ?? match[3] ?? '');
  }
  return attrs;
}
