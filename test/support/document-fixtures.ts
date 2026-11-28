import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import type { Response } from 'supertest';

export function captureBinaryBody(
  res: Response,
  callback: (err: Error | null, data: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'binary'));
  });
  res.once('end', () => callback(null, Buffer.concat(chunks)));
  res.once('error', (err: Error) => callback(err, Buffer.alloc(0)));
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function buildValidPng(): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(Buffer.from([0, 255, 0, 0]));
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function buildCorruptPng(): Buffer {
  const png = buildValidPng();
  png[png.length - 1] ^= 0xff;
  return png;
}

export function buildValidJpeg(): Buffer {
  const sof0Data = Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
  const sof0Len = Buffer.alloc(2);
  sof0Len.writeUInt16BE(sof0Data.length + 2, 0);

  const sosData = Buffer.from([1, 1, 0, 0, 63, 0]);
  const sosLen = Buffer.alloc(2);
  sosLen.writeUInt16BE(sosData.length + 2, 0);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc0]),
    sof0Len,
    sof0Data,
    Buffer.from([0xff, 0xda]),
    sosLen,
    sosData,
    Buffer.from([0x7f, 0xff, 0x00, 0xaa]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

export function buildCorruptJpeg(): Buffer {
  // Missing SOF/SOS and EOI trailer
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
}

export function buildValidPdf(note = 'Graduate Archive PDF'): Buffer {
  const parts = [
    '%PDF-1.4\n',
    `% ${note}\n`,
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n',
  ];
  const xrefOffset = Buffer.byteLength(parts.join(''), 'ascii');
  const xref =
    'xref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n';
  const trailer = `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(parts.join('') + xref + trailer, 'ascii');
}

export interface ZipEntryFixture {
  readonly name: string;
  readonly data: Buffer;
}

export function buildZipArchive(entries: readonly ZipEntryFixture[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data) >>> 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(checksum, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(entry.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt32LE(checksum, 16);
    cdh.writeUInt32LE(compressed.length, 20);
    cdh.writeUInt32LE(entry.data.length, 24);
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

export function buildValidDocx(
  extraEntries: readonly ZipEntryFixture[] = [],
  mainContentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
): Buffer {
  return buildZipArchive([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="${mainContentType}"/>` +
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
  ]);
}

export function buildValidXlsx(
  extraEntries: readonly ZipEntryFixture[] = [],
  mainContentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
): Buffer {
  return buildZipArchive([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="${mainContentType}"/>` +
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
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>`,
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
  ]);
}

export function buildMacroDocm(): Buffer {
  return buildValidDocx(
    [{ name: 'word/vbaProject.bin', data: Buffer.from('vba') }],
    'application/vnd.ms-word.document.macroEnabled.main+xml',
  );
}

export function buildMacroXlsm(): Buffer {
  return buildValidXlsx(
    [{ name: 'xl/vbaProject.bin', data: Buffer.from('vba') }],
    'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  );
}

export function buildOle2Doc(): Buffer {
  return Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(64, 0),
  ]);
}

export function buildPlainZip(): Buffer {
  return buildZipArchive([
    { name: 'hello.txt', data: Buffer.from('not an OOXML file', 'utf8') },
  ]);
}
