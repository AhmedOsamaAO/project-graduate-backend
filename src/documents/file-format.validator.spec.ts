import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import { ERROR_CODES } from '../common/errors/error-codes';
import { DocumentType } from '../generated/prisma/client';
import { validateFileFormat } from './file-format.validator';

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function buildValidPng(): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const idat = deflateSync(Buffer.from([0, 255, 0, 0]));
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildValidJpeg(): Buffer {
  const sof0Data = Buffer.from([
    8, // precision
    0,
    1, // height = 1
    0,
    1, // width = 1
    1, // components = 1
    1,
    0x11,
    0,
  ]);
  const sof0Len = Buffer.alloc(2);
  sof0Len.writeUInt16BE(sof0Data.length + 2, 0);

  const sosData = Buffer.from([1, 1, 0, 0, 63, 0]);
  const sosLen = Buffer.alloc(2);
  sosLen.writeUInt16BE(sosData.length + 2, 0);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xc0]), // SOF0
    sof0Len,
    sof0Data,
    Buffer.from([0xff, 0xda]), // SOS
    sosLen,
    sosData,
    Buffer.from([0x7f, 0xff, 0x00, 0xaa]), // entropy with stuffed FF 00
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

function buildValidPdf(): Buffer {
  const parts = [
    '%PDF-1.4\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n',
  ];
  const xrefOffset = Buffer.byteLength(parts.join(''), 'ascii');
  const xref =
    'xref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n';
  const trailer = `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(parts.join('') + xref + trailer, 'ascii');
}

interface ZipSpecEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly method?: 0 | 8;
  readonly forgedUncompressedSize?: number;
}

function buildZip(entries: readonly ZipSpecEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const checksum = crc32(entry.data) >>> 0;
    const uncompressedSize = entry.forgedUncompressedSize ?? entry.data.length;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(checksum, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(uncompressedSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(checksum, 16);
    cdh.writeUInt32LE(compressed.length, 20);
    cdh.writeUInt32LE(uncompressedSize, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);

    locals.push(lfh, nameBuf, compressed);
    centrals.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + compressed.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

function buildValidDocx(
  extraEntries: readonly ZipSpecEntry[] = [],
  contentTypeOverride = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
): Buffer {
  const entries: ZipSpecEntry[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="${contentTypeOverride}"/>` +
          `</Types>`,
        'utf8',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
          `</Relationships>`,
        'utf8',
      ),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>`,
        'utf8',
      ),
    },
    ...extraEntries,
  ];
  return buildZip(entries);
}

function buildValidXlsx(extraEntries: readonly ZipSpecEntry[] = []): Buffer {
  const entries: ZipSpecEntry[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
          `</Types>`,
        'utf8',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
          `</Relationships>`,
        'utf8',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        'utf8',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
          `</Relationships>`,
        'utf8',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
        'utf8',
      ),
    },
    ...extraEntries,
  ];
  return buildZip(entries);
}

describe('validateFileFormat', () => {
  let tempDir: string;
  let seq = 0;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'format-validator-spec-'));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeFixture(data: Buffer): Promise<string> {
    const filePath = join(tempDir, `fixture-${++seq}.bin`);
    await writeFile(filePath, data);
    return filePath;
  }

  it('validates real PDF, JPEG, PNG, DOCX, and XLSX payloads regardless of filename extension', async () => {
    const pdfPath = await writeFixture(buildValidPdf());
    const jpegPath = await writeFixture(buildValidJpeg());
    const pngPath = await writeFixture(buildValidPng());
    const docxPath = await writeFixture(buildValidDocx());
    const xlsxPath = await writeFixture(buildValidXlsx());

    await expect(
      validateFileFormat(pdfPath, DocumentType.TRANSCRIPT, 1024 * 1024),
    ).resolves.toEqual({
      mimeType: 'application/pdf',
      byteSize: (await Promise.resolve(buildValidPdf())).length,
    });
    await expect(
      validateFileFormat(jpegPath, DocumentType.PERSONAL_PHOTO, 1024 * 1024),
    ).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    await expect(
      validateFileFormat(pngPath, DocumentType.PERSONAL_PHOTO, 1024 * 1024),
    ).resolves.toMatchObject({ mimeType: 'image/png' });
    await expect(
      validateFileFormat(docxPath, DocumentType.OTHER, 1024 * 1024),
    ).resolves.toMatchObject({
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await expect(
      validateFileFormat(xlsxPath, DocumentType.OTHER, 1024 * 1024),
    ).resolves.toMatchObject({
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  });

  it('rejects empty files and files exceeding maxBytes', async () => {
    const emptyPath = await writeFixture(Buffer.alloc(0));
    await expect(
      validateFileFormat(emptyPath, DocumentType.OTHER, 1024),
    ).rejects.toMatchObject({ code: ERROR_CODES.UNSUPPORTED_FILE_FORMAT });

    const pdfPath = await writeFixture(buildValidPdf());
    await expect(
      validateFileFormat(pdfPath, DocumentType.OTHER, 16),
    ).rejects.toMatchObject({ code: ERROR_CODES.FILE_TOO_LARGE });
  });

  it('rejects symlinks rather than following them', async () => {
    const pngPath = await writeFixture(buildValidPng());
    const linkPath = join(tempDir, 'link.png');
    await symlink(pngPath, linkPath);

    await expect(
      validateFileFormat(linkPath, DocumentType.PERSONAL_PHOTO, 1024 * 1024),
    ).rejects.toMatchObject({ code: ERROR_CODES.UNSUPPORTED_FILE_FORMAT });
  });

  it('rejects PDF, DOCX, and XLSX when documentType is PERSONAL_PHOTO', async () => {
    for (const data of [buildValidPdf(), buildValidDocx(), buildValidXlsx()]) {
      const path = await writeFixture(data);
      await expect(
        validateFileFormat(path, DocumentType.PERSONAL_PHOTO, 1024 * 1024),
      ).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_PERSONAL_PHOTO_FORMAT,
      });
    }
  });

  it('rejects truncated/corrupt PNG, JPEG, and PDF files', async () => {
    const validPng = buildValidPng();
    const corruptPng = Buffer.from(validPng);
    corruptPng[corruptPng.length - 1] ^= 0xff;
    const trailingPng = Buffer.concat([validPng, Buffer.from('garbage')]);

    const validJpeg = buildValidJpeg();
    const truncatedJpeg = validJpeg.subarray(0, validJpeg.length - 2);
    const trailingJpeg = Buffer.concat([validJpeg, Buffer.from([0x00])]);

    const truncatedPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');

    for (const bad of [
      corruptPng,
      trailingPng,
      truncatedJpeg,
      trailingJpeg,
      truncatedPdf,
      Buffer.from('not a real document'),
    ]) {
      const path = await writeFixture(bad);
      await expect(
        validateFileFormat(path, DocumentType.OTHER, 1024 * 1024),
      ).rejects.toMatchObject({ code: ERROR_CODES.UNSUPPORTED_FILE_FORMAT });
    }
  });

  it('rejects legacy OLE2 binary files, plain ZIPs, macro-enabled packages, and ZIP traversal', async () => {
    const ole2 = Buffer.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00,
    ]);
    const plainZip = buildZip([
      { name: 'hello.txt', data: Buffer.from('hi') },
      { name: 'a.txt', data: Buffer.from('a') },
      { name: 'b.txt', data: Buffer.from('b') },
    ]);
    const docmByVba = buildValidDocx([
      { name: 'word/vbaProject.bin', data: Buffer.from('vba') },
    ]);
    const docmByContentType = buildValidDocx(
      [],
      'application/vnd.ms-word.document.macroEnabled.main+xml',
    );
    const traversalZip = buildValidDocx([
      { name: '../evil.txt', data: Buffer.from('x') },
    ]);
    const xxeZip = buildZip([
      {
        name: '[Content_Types].xml',
        data: Buffer.from(
          '<!DOCTYPE Types [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        ),
      },
      { name: '_rels/.rels', data: Buffer.from('<Relationships/>') },
      { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
    ]);

    for (const bad of [
      ole2,
      plainZip,
      docmByVba,
      docmByContentType,
      traversalZip,
      xxeZip,
    ]) {
      const path = await writeFixture(bad);
      await expect(
        validateFileFormat(path, DocumentType.OTHER, 1024 * 1024),
      ).rejects.toMatchObject({ code: ERROR_CODES.UNSUPPORTED_FILE_FORMAT });
    }
  });

  it('rejects ZIP bombs with forged uncompressed sizes or excessive inflated XML bytes', async () => {
    const forgedSizeZip = buildZip([
      {
        name: '[Content_Types].xml',
        data: Buffer.from(
          `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
        ),
        forgedUncompressedSize: 200 * 1024 * 1024,
      },
      { name: '_rels/.rels', data: Buffer.from('<Relationships/>') },
      { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
    ]);

    const hugeXmlPayload = Buffer.alloc(3 * 1024 * 1024, 0x20);
    const hugeDocxXmlZip = buildZip([
      {
        name: '[Content_Types].xml',
        data: Buffer.from(
          `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
            `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
            `</Types>`,
        ),
      },
      {
        name: '_rels/.rels',
        data: Buffer.from(
          `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
            `</Relationships>`,
        ),
      },
      {
        name: 'word/document.xml',
        data: hugeXmlPayload,
      },
    ]);

    for (const bad of [forgedSizeZip, hugeDocxXmlZip]) {
      const path = await writeFixture(bad);
      await expect(
        validateFileFormat(path, DocumentType.OTHER, 10 * 1024 * 1024),
      ).rejects.toMatchObject({ code: ERROR_CODES.UNSUPPORTED_FILE_FORMAT });
    }
  });
});
