import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { ChangeHistoryEntryView } from '../change-history/change-history';
import {
  ChangeHistoryEntryDto,
  HistoryStaffActorDto,
} from '../change-history/dto/change-history.dto';
import {
  ApiCommonErrorResponses,
  ApiCreatedDataResponse,
  ApiDataResponse,
  ApiPageResponse,
} from '../common/http/api-response.decorators';
import type { PageResult } from '../common/http/page';
import { ParsePositiveIntPipe } from '../common/http/parse-positive-int.pipe';
import { DocumentType } from '../generated/prisma/client';
import { CurrentSession } from '../staff-access/current-session.decorator';
import type { AuthenticatedSession } from '../staff-access/staff-auth.service';
import { DocumentsService } from './documents.service';
import {
  STUDENT_DOCUMENT_TYPES,
  validateIdempotencyKey,
} from './documents.validation';
import type { DocumentView, FileOperationView } from './documents.views';
import type { UploadExecutionResult } from './file-operation-executor';
import {
  DocumentDto,
  DocumentHistoryQueryDto,
  DocumentVersionActionDto,
  DownloadDocumentQueryDto,
  FileOperationDto,
  GetDocumentQueryDto,
  ListStudentDocumentsQueryDto,
  ListSupervisorDocumentsQueryDto,
  LookupFileOperationByKeyQueryDto,
  UpdateDocumentDto,
} from './dto/documents.dto';
import {
  createMultipartUploadSource,
  createSupervisorMultipartUploadSource,
} from './multipart-upload';

function applyUploadExecutionResponse(
  res: Response,
  result: UploadExecutionResult,
): DocumentView | FileOperationView {
  if (result.kind === 'COMPLETED') {
    res.setHeader('X-File-Operation-Id', String(result.operationId));
    res.status(HttpStatus.CREATED);
    return result.document;
  }

  res.setHeader('X-File-Operation-Id', String(result.operation.id));
  res.status(HttpStatus.ACCEPTED);
  return result.operation;
}

@ApiTags('documents')
@ApiCookieAuth('graduate_session')
@ApiCommonErrorResponses()
@ApiExtraModels(DocumentDto, FileOperationDto)
@Controller('students/:studentId/documents')
export class StudentDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @ApiOperation({
    summary:
      "List a student's supporting documents (defaults to active documents under active parents)",
  })
  @ApiPageResponse(
    { $ref: getSchemaPath(DocumentDto) },
    'Paged student documents',
  )
  list(
    @Param('studentId', ParsePositiveIntPipe) studentId: number,
    @Query() query: ListStudentDocumentsQueryDto,
  ): Promise<PageResult<DocumentView>> {
    return this.documents.listStudentDocuments(studentId, query);
  }

  @Post()
  @ApiOperation({
    summary:
      'Upload a supporting document for a student using multipart/form-data and a staff-scoped Idempotency-Key',
  })
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Staff-scoped idempotency key (1–128 printable characters)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['documentType', 'file'],
      properties: {
        documentType: { type: 'string', enum: STUDENT_DOCUMENT_TYPES },
        qualificationId: { type: 'integer', minimum: 1 },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiCreatedDataResponse(
    { $ref: getSchemaPath(DocumentDto) },
    'Document uploaded and published (including idempotent replay)',
  )
  @ApiAcceptedResponse({
    description: 'Upload operation is still in progress or cleaning up',
    schema: {
      type: 'object',
      required: ['data'],
      properties: { data: { $ref: getSchemaPath(FileOperationDto) } },
    },
  })
  async upload(
    @CurrentSession() session: AuthenticatedSession,
    @Param('studentId', ParsePositiveIntPipe) studentId: number,
    @Headers('idempotency-key')
    rawIdempotencyKey: string | string[] | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentView | FileOperationView> {
    const idempotencyKey = validateIdempotencyKey(
      Array.isArray(rawIdempotencyKey) ? undefined : rawIdempotencyKey,
    );
    const result = await this.documents.uploadStudentDocument(
      { staffUserId: session.user.id },
      studentId,
      idempotencyKey,
      createMultipartUploadSource(req),
    );
    return applyUploadExecutionResponse(res, result);
  }
}

@ApiTags('documents')
@ApiCookieAuth('graduate_session')
@ApiCommonErrorResponses()
@ApiExtraModels(DocumentDto, FileOperationDto)
@Controller('supervisors/:supervisorId/documents')
export class SupervisorDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @ApiOperation({
    summary:
      "List a supervisor's supporting documents (defaults to active documents)",
  })
  @ApiPageResponse(
    { $ref: getSchemaPath(DocumentDto) },
    'Paged supervisor documents',
  )
  list(
    @Param('supervisorId', ParsePositiveIntPipe) supervisorId: number,
    @Query() query: ListSupervisorDocumentsQueryDto,
  ): Promise<PageResult<DocumentView>> {
    return this.documents.listSupervisorDocuments(supervisorId, query);
  }

  @Post()
  @ApiOperation({
    summary:
      'Upload a supporting document for a supervisor using multipart/form-data and a staff-scoped Idempotency-Key',
  })
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Staff-scoped idempotency key (1–128 printable characters)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        documentType: {
          type: 'string',
          enum: [DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT],
          default: DocumentType.SUPERVISOR_SUPPORTING_DOCUMENT,
        },
        description: { type: 'string', maxLength: 500 },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiCreatedDataResponse(
    { $ref: getSchemaPath(DocumentDto) },
    'Document uploaded and published (including idempotent replay)',
  )
  @ApiAcceptedResponse({
    description: 'Upload operation is still in progress or cleaning up',
    schema: {
      type: 'object',
      required: ['data'],
      properties: { data: { $ref: getSchemaPath(FileOperationDto) } },
    },
  })
  async upload(
    @CurrentSession() session: AuthenticatedSession,
    @Param('supervisorId', ParsePositiveIntPipe) supervisorId: number,
    @Headers('idempotency-key')
    rawIdempotencyKey: string | string[] | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentView | FileOperationView> {
    const idempotencyKey = validateIdempotencyKey(
      Array.isArray(rawIdempotencyKey) ? undefined : rawIdempotencyKey,
    );
    const result = await this.documents.uploadSupervisorDocument(
      { staffUserId: session.user.id },
      supervisorId,
      idempotencyKey,
      createSupervisorMultipartUploadSource(req),
    );
    return applyUploadExecutionResponse(res, result);
  }
}

@ApiTags('documents')
@ApiCookieAuth('graduate_session')
@ApiCommonErrorResponses()
@ApiExtraModels(DocumentDto, ChangeHistoryEntryDto, HistoryStaffActorDto)
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get document metadata by ID' })
  @ApiDataResponse({ $ref: getSchemaPath(DocumentDto) }, 'Document metadata')
  get(
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: GetDocumentQueryDto,
  ): Promise<DocumentView> {
    return this.documents.getDocument(id, {
      includeArchived: query.includeArchived,
    });
  }

  @Get(':id/download')
  @ApiOperation({
    summary: 'Stream a supporting document file through authenticated access',
  })
  @ApiProduces(
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  @ApiOkResponse({
    description: 'Authenticated document file stream',
    schema: { type: 'string', format: 'binary' },
  })
  async download(
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: DownloadDocumentQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const resolved = await this.documents.resolveDocumentDownload(id, {
      includeArchived: query.includeArchived,
      disposition: query.disposition,
    });
    res.setHeader('Content-Type', resolved.mimeType);
    res.setHeader('Content-Length', String(resolved.byteSize));
    res.setHeader('Content-Disposition', resolved.contentDisposition);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.once('close', () => {
      if (!res.writableFinished && !resolved.stream.destroyed) {
        resolved.stream.destroy();
      }
    });
    return new StreamableFile(resolved.stream);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update active document metadata (student category/qualification link or supervisor description)',
  })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(DocumentDto) },
    'Updated document metadata',
  )
  update(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: UpdateDocumentDto,
  ): Promise<DocumentView> {
    return this.documents.updateDocument(
      { staffUserId: session.user.id },
      id,
      body,
    );
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive an active document record' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(DocumentDto) },
    'Archived document metadata',
  )
  archive(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: DocumentVersionActionDto,
  ): Promise<DocumentView> {
    return this.documents.archiveDocument(
      { staffUserId: session.user.id },
      id,
      body.expectedVersion,
    );
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an archived document record' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(DocumentDto) },
    'Restored document metadata',
  )
  restore(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: DocumentVersionActionDto,
  ): Promise<DocumentView> {
    return this.documents.restoreDocument(
      { staffUserId: session.user.id },
      id,
      body.expectedVersion,
    );
  }

  @Get(':id/history')
  @ApiOperation({
    summary: 'List change history for a document record (newest first)',
  })
  @ApiPageResponse(
    { $ref: getSchemaPath(ChangeHistoryEntryDto) },
    'Paged change history entries',
  )
  history(
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: DocumentHistoryQueryDto,
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    return this.documents.getDocumentHistory(id, query);
  }
}

@ApiTags('file-operations')
@ApiCookieAuth('graduate_session')
@ApiCommonErrorResponses()
@ApiExtraModels(FileOperationDto)
@Controller('file-operations')
export class FileOperationsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('by-key')
  @ApiOperation({
    summary: 'Look up a file operation by staff-scoped Idempotency-Key',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(FileOperationDto) },
    'Sanitized file operation status',
  )
  getByKey(
    @CurrentSession() session: AuthenticatedSession,
    @Query() query: LookupFileOperationByKeyQueryDto,
  ): Promise<FileOperationView> {
    return this.documents.getFileOperationByKey(
      { staffUserId: session.user.id },
      query.kind,
      query.idempotencyKey,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Look up a file operation by ID' })
  @ApiDataResponse(
    { $ref: getSchemaPath(FileOperationDto) },
    'Sanitized file operation status',
  )
  get(
    @Param('id', ParsePositiveIntPipe) id: number,
  ): Promise<FileOperationView> {
    return this.documents.getFileOperation(id);
  }
}
