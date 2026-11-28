import { PrismaPg } from '@prisma/adapter-pg';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ChangeHistoryService } from '../../src/change-history/change-history.service';
import { ApiError } from '../../src/common/errors/api-error';
import { ERROR_CODES } from '../../src/common/errors/error-codes';
import { loadAppConfig, type AppConfig } from '../../src/config/app-config';
import { DocumentArchiveGuardRegistry } from '../../src/documents/document-archive-guard';
import { DocumentsService } from '../../src/documents/documents.service';
import {
  FileOperationExecutor,
  type FileOperationFaultCutPoint,
  type FileOperationFaultHook,
} from '../../src/documents/file-operation-executor';
import { createSupervisorBufferUploadSource } from '../../src/documents/multipart-upload';
import { PrivateFileStorage } from '../../src/documents/private-file-storage';
import {
  AcademicRank,
  DocumentAvailability,
  DocumentType,
  ExternalApprovalStatus,
  FileOperationStatus,
  InstitutionType,
  PrismaClient,
  SupervisorAffiliation,
} from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FIXED_OFFICE } from '../../src/reference-data/fixed-office';
import { ReferenceDataService } from '../../src/reference-data/reference-data.service';
import { StaffAccounts } from '../../src/staff-access/staff-accounts';
import { StudentArchiveGuardRegistry } from '../../src/students/student-archive-guard';
import { StudentsService } from '../../src/students/students.service';
import { createSupervisorApprovalDocumentArchiveGuard } from '../../src/supervisors/supervisor-approval-document-archive-guard';
import { SupervisorCorrectionGuardRegistry } from '../../src/supervisors/supervisor-correction-guard';
import { SupervisorsService } from '../../src/supervisors/supervisors.service';
import { buildValidPdf } from '../support/document-fixtures';
import {
  createTestDatabase,
  withAdminClient,
  type TestDatabase,
} from '../support/test-database';
import { createTestStorage, type TestStorage } from '../support/test-storage';

describe('supervisors, external approval, and supervisor documents (db)', () => {
  let database: TestDatabase;
  let storage: TestStorage;
  let appConfig: AppConfig;
  let prisma: PrismaClient;
  let historyService: ChangeHistoryService;
  let referenceData: ReferenceDataService;
  let studentsService: StudentsService;
  let storageService: PrivateFileStorage;
  let docArchiveGuards: DocumentArchiveGuardRegistry;
  let supervisorCorrectionGuards: SupervisorCorrectionGuardRegistry;
  let executor: FileOperationExecutor;
  let documentsService: DocumentsService;
  let supervisorsService: SupervisorsService;
  let unregisterApprovalGuard: (() => void) | undefined;
  let faultCutHookImpl: FileOperationFaultHook = {
    onCutPoint: () => undefined,
  };
  let staffUserId: number;
  let operatingDeptId: number;
  let otherFacultyId: number;
  let externalDeptId: number;

  beforeAll(async () => {
    database = await createTestDatabase();
    storage = await createTestStorage();
    appConfig = loadAppConfig({
      ...process.env,
      DATABASE_URL: database.runtimeUrl,
      PRIVATE_STORAGE_ROOT: storage.path,
    });
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: database.runtimeUrl }),
    });
    historyService = new ChangeHistoryService(
      prisma as unknown as PrismaService,
    );
    referenceData = new ReferenceDataService(
      prisma as unknown as PrismaService,
      historyService,
    );
    studentsService = new StudentsService(
      prisma as unknown as PrismaService,
      historyService,
      new StudentArchiveGuardRegistry(),
    );
    storageService = new PrivateFileStorage(appConfig);
    docArchiveGuards = new DocumentArchiveGuardRegistry();
    unregisterApprovalGuard = docArchiveGuards.register(
      createSupervisorApprovalDocumentArchiveGuard(),
    );
    supervisorCorrectionGuards = new SupervisorCorrectionGuardRegistry();

    const faultHookProxy: FileOperationFaultHook = {
      onCutPoint(cutPoint, context) {
        return faultCutHookImpl.onCutPoint(cutPoint, context);
      },
    };
    executor = new FileOperationExecutor(
      prisma as unknown as PrismaService,
      appConfig,
      storageService,
      studentsService,
      undefined,
      faultHookProxy,
    );
    await executor.onModuleInit();

    documentsService = new DocumentsService(
      prisma as unknown as PrismaService,
      historyService,
      studentsService,
      docArchiveGuards,
      storageService,
      executor,
    );
    supervisorsService = new SupervisorsService(
      prisma as unknown as PrismaService,
      historyService,
      supervisorCorrectionGuards,
    );

    const accounts = new StaffAccounts(prisma);
    const staff = await accounts.provision(
      { attribution: 'supervisors db test' },
      {
        username: 'supervisors.db.staff',
        fullName: 'Supervisors DB Staff',
        password: 'supervisors db valid password',
      },
    );
    staffUserId = staff.id;

    const csDept = await referenceData.createDepartment(
      { staffUserId },
      { facultyId: FIXED_OFFICE.faculty.id, name: 'CS Supervisors Dept' },
    );
    operatingDeptId = csDept.id;

    const extInst = await referenceData.createInstitution(
      { staffUserId },
      {
        name: 'External Tech University',
        institutionType: InstitutionType.PUBLIC_UNIVERSITY,
      },
    );
    const extFac = await referenceData.createFaculty(
      { staffUserId },
      { institutionId: extInst.id, name: 'Faculty of Engineering' },
    );
    otherFacultyId = extFac.id;
    const extDept = await referenceData.createDepartment(
      { staffUserId },
      { facultyId: extFac.id, name: 'Systems Engineering' },
    );
    externalDeptId = extDept.id;
  });

  afterEach(() => {
    faultCutHookImpl = { onCutPoint: () => undefined };
  });

  afterAll(async () => {
    await executor?.onModuleDestroy().catch(() => undefined);
    unregisterApprovalGuard?.();
    await prisma?.$disconnect();
    await storage?.remove();
    await database?.drop();
  });

  const stagingFiles = () => readdir(join(storage.path, 'staging'));
  const objectFiles = () => readdir(join(storage.path, 'objects'));

  it('enforces supervisor, exclusive document owner, triggers, and runtime privilege restrictions', async () => {
    const internalSup = await supervisorsService.createSupervisor(
      { staffUserId },
      {
        fullName: 'Dr. Internal Trigger Check',
        academicRank: AcademicRank.PROFESSOR,
        affiliation: SupervisorAffiliation.INTERNAL,
        departmentId: operatingDeptId,
      },
    );
    const externalSup = await supervisorsService.createSupervisor(
      { staffUserId },
      {
        fullName: 'Dr. External Dept Ref',
        academicRank: AcademicRank.LECTURER,
        affiliation: SupervisorAffiliation.EXTERNAL,
        workplace: 'External Tech University',
        departmentId: externalDeptId,
      },
    );

    const docUpload = await documentsService.uploadSupervisorDocument(
      { staffUserId },
      externalSup.id,
      'sql-trigger-doc-1',
      createSupervisorBufferUploadSource({
        description: 'SQL trigger test',
        originalFileName: 'letter.pdf',
        content: buildValidPdf('SQL Guard Check'),
      }),
    );
    if (docUpload.kind !== 'COMPLETED') {
      throw new Error('Expected upload to complete');
    }

    const student = await studentsService.createStudent(
      { staffUserId },
      { fullName: 'Owner Exclusivity Student', nationalId: '29901011234999' },
    );

    await withAdminClient(database.url, async (admin) => {
      const { rows: supCols } = await admin.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'supervisor'
         ORDER BY ordinal_position`,
      );
      expect(supCols.map((r) => r.column_name)).toEqual([
        'id',
        'full_name',
        'academic_rank',
        'affiliation',
        'department_id',
        'workplace',
        'phone',
        'email',
        'national_id',
        'external_approval_status',
        'external_rejection_reason',
        'deactivated_at',
        'version',
        'created_at',
        'updated_at',
      ]);

      const badSupervisorSqls = [
        // Blank full_name
        `INSERT INTO supervisor (full_name, academic_rank, affiliation, department_id, updated_at)
         VALUES ('   ', 'PROFESSOR', 'INTERNAL', ${operatingDeptId}, CURRENT_TIMESTAMP)`,
        // INTERNAL with workplace
        `INSERT INTO supervisor (full_name, academic_rank, affiliation, department_id, workplace, updated_at)
         VALUES ('Bad Internal', 'PROFESSOR', 'INTERNAL', ${operatingDeptId}, 'Lab', CURRENT_TIMESTAMP)`,
        // INTERNAL without department_id
        `INSERT INTO supervisor (full_name, academic_rank, affiliation, updated_at)
         VALUES ('Bad Internal', 'PROFESSOR', 'INTERNAL', CURRENT_TIMESTAMP)`,
        // INTERNAL with non-operating-faculty department (trigger)
        `INSERT INTO supervisor (full_name, academic_rank, affiliation, department_id, updated_at)
         VALUES ('Wrong Faculty Internal', 'PROFESSOR', 'INTERNAL', ${externalDeptId}, CURRENT_TIMESTAMP)`,
        // EXTERNAL without workplace
        `INSERT INTO supervisor (full_name, academic_rank, affiliation, external_approval_status, updated_at)
         VALUES ('Bad External', 'LECTURER', 'EXTERNAL', 'PENDING', CURRENT_TIMESTAMP)`,
        // EXTERNAL without external_approval_status
        `INSERT INTO supervisor (full_name, academic_rank, affiliation, workplace, updated_at)
         VALUES ('Bad External', 'LECTURER', 'EXTERNAL', 'Uni', CURRENT_TIMESTAMP)`,
        // EXTERNAL rejection reason when not REJECTED
        `INSERT INTO supervisor (full_name, academic_rank, affiliation, workplace, external_approval_status, external_rejection_reason, updated_at)
         VALUES ('Bad Reason', 'LECTURER', 'EXTERNAL', 'Uni', 'APPROVED', 'Nope', CURRENT_TIMESTAMP)`,
      ];
      for (const sql of badSupervisorSqls) {
        await expect(admin.query(sql)).rejects.toThrow();
      }

      // Exclusive document owner & category checks
      const keyA = 'a'.repeat(64);
      const keyB = 'b'.repeat(64);
      const badDocumentSqls = [
        // Dual owner
        `INSERT INTO document (student_id, supervisor_id, document_type, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES (${student.id}, ${externalSup.id}, 'SUPERVISOR_SUPPORTING_DOCUMENT', 'x.pdf', '${keyA}', 'application/pdf', 100, CURRENT_TIMESTAMP)`,
        // No owner
        `INSERT INTO document (document_type, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES ('OTHER', 'x.pdf', '${keyA}', 'application/pdf', 100, CURRENT_TIMESTAMP)`,
        // Student doc using supervisor category
        `INSERT INTO document (student_id, document_type, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES (${student.id}, 'SUPERVISOR_SUPPORTING_DOCUMENT', 'x.pdf', '${keyA}', 'application/pdf', 100, CURRENT_TIMESTAMP)`,
        // Student doc with description
        `INSERT INTO document (student_id, document_type, description, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES (${student.id}, 'OTHER', 'Not allowed', 'x.pdf', '${keyA}', 'application/pdf', 100, CURRENT_TIMESTAMP)`,
        // Supervisor doc with non-generic category
        `INSERT INTO document (supervisor_id, document_type, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES (${externalSup.id}, 'OTHER', 'x.pdf', '${keyA}', 'application/pdf', 100, CURRENT_TIMESTAMP)`,
        // Blank description
        `INSERT INTO document (supervisor_id, document_type, description, original_file_name, storage_key, mime_type, byte_size, updated_at)
         VALUES (${externalSup.id}, 'SUPERVISOR_SUPPORTING_DOCUMENT', '   ', 'x.pdf', '${keyA}', 'application/pdf', 100, CURRENT_TIMESTAMP)`,
      ];
      for (const sql of badDocumentSqls) {
        await expect(admin.query(sql)).rejects.toThrow();
      }

      // Exclusive file_operation owner
      await expect(
        admin.query(
          `INSERT INTO file_operation (kind, status, requested_by_staff_user_id, student_id, supervisor_id, idempotency_key, staging_key, storage_key, updated_at)
           VALUES ('UPLOAD', 'IN_PROGRESS', ${staffUserId}, ${student.id}, ${externalSup.id}, 'bad-owner-1', '${keyA}', '${keyB}', CURRENT_TIMESTAMP)`,
        ),
      ).rejects.toThrow();
      await expect(
        admin.query(
          `INSERT INTO file_operation (kind, status, requested_by_staff_user_id, idempotency_key, staging_key, storage_key, updated_at)
           VALUES ('UPLOAD', 'IN_PROGRESS', ${staffUserId}, 'bad-owner-2', '${keyA}', '${keyB}', CURRENT_TIMESTAMP)`,
        ),
      ).rejects.toThrow();

      // Immutable document.supervisor_id trigger
      await expect(
        admin.query(
          `UPDATE document SET supervisor_id = ${internalSup.id} WHERE id = ${docUpload.document.id}`,
        ),
      ).rejects.toThrow(/Immutable document fields/i);
    });

    // Reparenting department referenced by internal supervisor fails with RECORD_IN_USE
    const opDeptLatest = await referenceData.getDepartment(operatingDeptId);
    await expect(
      referenceData.updateDepartment({ staffUserId }, operatingDeptId, {
        expectedVersion: opDeptLatest.version,
        facultyId: otherFacultyId,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

    // Deleting referenced department fails with RECORD_IN_USE
    await expect(
      referenceData.deleteDepartment(
        { staffUserId },
        externalDeptId,
        (await referenceData.getDepartment(externalDeptId)).version,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECORD_IN_USE });

    // Runtime role has no DELETE or TRUNCATE privileges on supervisor
    await expect(
      prisma.$executeRaw`DELETE FROM supervisor WHERE id = ${internalSup.id}`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE supervisor'),
    ).rejects.toThrow();
  });

  it('supports all four ranks, non-Egyptian/leading-zero national IDs, affiliation rules, and typed search', async () => {
    const dept2 = await referenceData.createDepartment(
      { staffUserId },
      { facultyId: FIXED_OFFICE.faculty.id, name: 'AI Supervisors Dept' },
    );

    const ranks: AcademicRank[] = [
      AcademicRank.PROFESSOR,
      AcademicRank.ASSOCIATE_PROFESSOR,
      AcademicRank.LECTURER,
      AcademicRank.ASSOCIATE_LECTURER,
    ];
    for (const [idx, rank] of ranks.entries()) {
      const sup = await supervisorsService.createSupervisor(
        { staffUserId },
        {
          fullName: `Dr. Rank ${idx}`,
          academicRank: rank,
          affiliation: SupervisorAffiliation.INTERNAL,
          departmentId: dept2.id,
          nationalId: `00077${idx}`,
        },
      );
      expect(sup.academicRank).toBe(rank);
      expect(sup.nationalId).toBe(`00077${idx}`);
    }

    // Non-unique, non-14-digit national IDs allowed across supervisors
    const international = await supervisorsService.createSupervisor(
      { staffUserId },
      {
        fullName: 'Prof. International Scholar',
        academicRank: AcademicRank.PROFESSOR,
        affiliation: SupervisorAffiliation.EXTERNAL,
        workplace: 'TU Munich',
        nationalId: '000770',
      },
    );
    expect(international.nationalId).toBe('000770');
    expect(international.externalApprovalStatus).toBe(
      ExternalApprovalStatus.PENDING,
    );

    // Search preserving leading zeros matches both internal and external supervisors
    const matches = await supervisorsService.listSupervisors({
      nationalId: '000770',
    });
    expect(matches.items).toHaveLength(2);
  });

  it('prevents approving without evidence or archiving last document across concurrent race trials', async () => {
    // Race 1: Concurrent approve vs archive last document
    for (let trial = 0; trial < 10; trial += 1) {
      const ext = await supervisorsService.createSupervisor(
        { staffUserId },
        {
          fullName: `Race Approve vs Archive ${trial}`,
          academicRank: AcademicRank.ASSOCIATE_PROFESSOR,
          affiliation: SupervisorAffiliation.EXTERNAL,
          workplace: 'Cairo University',
        },
      );
      const uploaded = await documentsService.uploadSupervisorDocument(
        { staffUserId },
        ext.id,
        `race-approve-archive-${trial}`,
        createSupervisorBufferUploadSource({
          description: 'Endorsement PDF',
          originalFileName: `endorsement-${trial}.pdf`,
          content: buildValidPdf(`Race 1 Trial ${trial}`),
        }),
      );
      if (uploaded.kind !== 'COMPLETED') {
        throw new Error('Expected upload to complete');
      }

      const results = await Promise.allSettled([
        supervisorsService.updateExternalApproval({ staffUserId }, ext.id, {
          expectedVersion: ext.version,
          status: ExternalApprovalStatus.APPROVED,
        }),
        documentsService.archiveDocument(
          { staffUserId },
          uploaded.document.id,
          uploaded.document.version,
        ),
      ]);

      const successes = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toMatchObject({
        code: ERROR_CODES.SUPERVISOR_APPROVAL_REQUIRES_DOCUMENT,
      });

      const finalSupervisor = await supervisorsService.getSupervisor(ext.id);
      const activeDocs = await prisma.document.count({
        where: {
          supervisorId: ext.id,
          archivedAt: null,
          availability: DocumentAvailability.AVAILABLE,
        },
      });
      if (finalSupervisor.externalApprovalStatus === 'APPROVED') {
        expect(activeDocs).toBe(1);
      } else {
        expect(finalSupervisor.externalApprovalStatus).toBe('PENDING');
        expect(activeDocs).toBe(0);
      }
    }

    // Race 2: Concurrent archive(doc1) vs archive(doc2) on already-APPROVED supervisor with 2 docs
    for (let trial = 0; trial < 10; trial += 1) {
      const ext = await supervisorsService.createSupervisor(
        { staffUserId },
        {
          fullName: `Race Archive Both ${trial}`,
          academicRank: AcademicRank.LECTURER,
          affiliation: SupervisorAffiliation.EXTERNAL,
          workplace: 'Mansoura University',
        },
      );
      const up1 = await documentsService.uploadSupervisorDocument(
        { staffUserId },
        ext.id,
        `race-two-docs-a-${trial}`,
        createSupervisorBufferUploadSource({
          originalFileName: `a-${trial}.pdf`,
          content: buildValidPdf(`Doc A ${trial}`),
        }),
      );
      const up2 = await documentsService.uploadSupervisorDocument(
        { staffUserId },
        ext.id,
        `race-two-docs-b-${trial}`,
        createSupervisorBufferUploadSource({
          originalFileName: `b-${trial}.pdf`,
          content: buildValidPdf(`Doc B ${trial}`),
        }),
      );
      if (up1.kind !== 'COMPLETED' || up2.kind !== 'COMPLETED') {
        throw new Error('Expected both uploads to complete');
      }

      await supervisorsService.updateExternalApproval({ staffUserId }, ext.id, {
        expectedVersion: ext.version,
        status: ExternalApprovalStatus.APPROVED,
      });

      const results = await Promise.allSettled([
        documentsService.archiveDocument(
          { staffUserId },
          up1.document.id,
          up1.document.version,
        ),
        documentsService.archiveDocument(
          { staffUserId },
          up2.document.id,
          up2.document.version,
        ),
      ]);

      const successes = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toMatchObject({
        code: ERROR_CODES.SUPERVISOR_APPROVAL_REQUIRES_DOCUMENT,
      });

      const activeDocs = await prisma.document.count({
        where: {
          supervisorId: ext.id,
          archivedAt: null,
          availability: DocumentAvailability.AVAILABLE,
        },
      });
      expect(activeDocs).toBe(1);
    }
  });

  it('enforces approval status downgrade to unlock last document archive, deactivation, guard seam, and stale versions', async () => {
    const ext = await supervisorsService.createSupervisor(
      { staffUserId },
      {
        fullName: 'Dr. Lifecycle Check',
        academicRank: AcademicRank.PROFESSOR,
        affiliation: SupervisorAffiliation.EXTERNAL,
        workplace: 'Benha University',
      },
    );
    const up = await documentsService.uploadSupervisorDocument(
      { staffUserId },
      ext.id,
      'lifecycle-doc-1',
      createSupervisorBufferUploadSource({
        description: 'CV',
        originalFileName: 'cv.pdf',
        content: buildValidPdf('Lifecycle CV'),
      }),
    );
    if (up.kind !== 'COMPLETED') throw new Error('Expected upload');

    const approved = await supervisorsService.updateExternalApproval(
      { staffUserId },
      ext.id,
      { expectedVersion: ext.version, status: ExternalApprovalStatus.APPROVED },
    );

    // Last doc cannot be archived while approved
    await expect(
      documentsService.archiveDocument(
        { staffUserId },
        up.document.id,
        up.document.version,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SUPERVISOR_APPROVAL_REQUIRES_DOCUMENT,
    });

    // Rejecting approval unlocks archiving the last doc
    const rejected = await supervisorsService.updateExternalApproval(
      { staffUserId },
      ext.id,
      {
        expectedVersion: approved.version,
        status: ExternalApprovalStatus.REJECTED,
        rejectionReason: 'Superseded letter',
      },
    );
    const archivedDoc = await documentsService.archiveDocument(
      { staffUserId },
      up.document.id,
      up.document.version,
    );
    expect(archivedDoc.archivedAt).not.toBeNull();

    // Re-approving while doc is archived fails; restoring unlocks approval
    await expect(
      supervisorsService.updateExternalApproval({ staffUserId }, ext.id, {
        expectedVersion: rejected.version,
        status: ExternalApprovalStatus.APPROVED,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SUPERVISOR_APPROVAL_REQUIRES_DOCUMENT,
    });

    await documentsService.restoreDocument(
      { staffUserId },
      archivedDoc.id,
      archivedDoc.version,
    );
    const reapproved = await supervisorsService.updateExternalApproval(
      { staffUserId },
      ext.id,
      {
        expectedVersion: rejected.version,
        status: ExternalApprovalStatus.APPROVED,
      },
    );

    // Registered correction guard rolls back atomically on incompatible correction
    const unregister = supervisorCorrectionGuards.register({
      name: 'db-test-guard',
      assertCanCorrect: (_tx, ctx) => {
        if (ctx.next.affiliation === SupervisorAffiliation.INTERNAL) {
          return Promise.reject(
            new ApiError(
              409,
              ERROR_CODES.SUPERVISOR_CORRECTION_CONFLICT,
              'Incompatible appointment',
            ),
          );
        }
        return Promise.resolve();
      },
    });

    try {
      await expect(
        supervisorsService.updateSupervisor({ staffUserId }, ext.id, {
          expectedVersion: reapproved.version,
          affiliation: SupervisorAffiliation.INTERNAL,
          departmentId: operatingDeptId,
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.SUPERVISOR_CORRECTION_CONFLICT,
      });

      const unchanged = await supervisorsService.getSupervisor(ext.id);
      expect(unchanged.version).toBe(reapproved.version);
      expect(unchanged.affiliation).toBe(SupervisorAffiliation.EXTERNAL);

      // Deactivation succeeds without invoking correction guard and rejects stale version
      await expect(
        supervisorsService.deactivateSupervisor(
          { staffUserId },
          ext.id,
          reapproved.version - 1,
        ),
      ).rejects.toMatchObject({ code: ERROR_CODES.STALE_VERSION });

      const deactivated = await supervisorsService.deactivateSupervisor(
        { staffUserId },
        ext.id,
        reapproved.version,
      );
      expect(deactivated.deactivatedAt).not.toBeNull();
      expect(
        (await documentsService.listSupervisorDocuments(ext.id)).items,
      ).toHaveLength(1);
    } finally {
      unregister();
    }
  });

  it('cleans up abandoned supervisor upload operations without publishing a document', async () => {
    const sup = await supervisorsService.createSupervisor(
      { staffUserId },
      {
        fullName: 'Dr. Interrupted Upload',
        academicRank: AcademicRank.LECTURER,
        affiliation: SupervisorAffiliation.EXTERNAL,
        workplace: 'Suez Canal University',
      },
    );
    const beforeObjects = await objectFiles();

    faultCutHookImpl = {
      onCutPoint(cutPoint: FileOperationFaultCutPoint) {
        if (cutPoint === 'AFTER_PREPARE_BEFORE_PUBLISH') {
          throw new Error('Simulated crash before publish');
        }
      },
    };

    await expect(
      documentsService.uploadSupervisorDocument(
        { staffUserId },
        sup.id,
        'abandoned-sup-upload',
        createSupervisorBufferUploadSource({
          description: 'Interrupted PDF',
          originalFileName: 'interrupted.pdf',
          content: buildValidPdf('Interrupted'),
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.SERVICE_UNAVAILABLE });

    expect(
      await prisma.document.count({ where: { supervisorId: sup.id } }),
    ).toBe(0);
    const op = await prisma.fileOperation.findUnique({
      where: {
        requestedByStaffUserId_kind_idempotencyKey: {
          requestedByStaffUserId: staffUserId,
          kind: 'UPLOAD',
          idempotencyKey: 'abandoned-sup-upload',
        },
      },
    });
    expect(op?.status).toBe(FileOperationStatus.FAILED);
    expect(op?.supervisorId).toBe(sup.id);
    expect(op?.studentId).toBeNull();
    expect(await stagingFiles()).toEqual([]);
    expect(await objectFiles()).toEqual(beforeObjects);
  });
});
