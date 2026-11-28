import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { loadAppConfig } from '../../src/config/app-config';
import { DocumentsService } from '../../src/documents/documents.service';
import {
  FILE_OPERATION_FAULT_HOOK,
  type FileOperationFaultCutPoint,
} from '../../src/documents/file-operation-executor';
import { createBufferUploadSource } from '../../src/documents/multipart-upload';
import { DocumentType } from '../../src/generated/prisma/client';
import { buildValidPdf } from './document-fixtures';

async function main(): Promise<void> {
  const cutPoint = process.env.CRASH_CUT_POINT as
    FileOperationFaultCutPoint | undefined;
  const staffUserId = Number(process.env.WORKER_STAFF_USER_ID);
  const studentId = Number(process.env.WORKER_STUDENT_ID);
  const idempotencyKey = process.env.WORKER_IDEMPOTENCY_KEY;
  const payloadMode = process.env.WORKER_PAYLOAD_MODE ?? 'valid-pdf';
  const rawQualificationId = process.env.WORKER_QUALIFICATION_ID;
  const qualificationId = rawQualificationId
    ? Number(rawQualificationId)
    : null;

  if (
    !cutPoint ||
    !Number.isInteger(staffUserId) ||
    !Number.isInteger(studentId) ||
    !idempotencyKey
  ) {
    throw new Error(
      'Missing required crash-upload-worker environment variables',
    );
  }

  const config = loadAppConfig();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(FILE_OPERATION_FAULT_HOOK)
    .useValue({
      onCutPoint(current: FileOperationFaultCutPoint) {
        if (current === cutPoint) {
          process.kill(process.pid, 'SIGKILL');
        }
      },
    })
    .compile();

  await moduleRef.init();

  try {
    const documents = moduleRef.get(DocumentsService);
    const source = createBufferUploadSource({
      documentType: DocumentType.TRANSCRIPT,
      qualificationId,
      originalFileName:
        payloadMode === 'invalid-pdf' ? 'spoof.pdf' : 'transcript.pdf',
      content:
        payloadMode === 'invalid-pdf'
          ? Buffer.from('not a real pdf payload', 'utf8')
          : buildValidPdf('Crash Worker Upload'),
    });

    await documents.uploadStudentDocument(
      { staffUserId },
      studentId,
      idempotencyKey,
      source,
    );
  } finally {
    await moduleRef.close().catch(() => undefined);
  }

  console.error(
    `Worker reached completion without triggering cut point ${cutPoint}`,
  );
  process.exit(2);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(3);
});
