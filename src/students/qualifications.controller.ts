import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiExtraModels,
  ApiHeader,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
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
import { CurrentSession } from '../staff-access/current-session.decorator';
import type { AuthenticatedSession } from '../staff-access/staff-auth.service';
import {
  CreateQualificationDto,
  GetQualificationQueryDto,
  ListStudentQualificationsQueryDto,
  QualificationDto,
  QualificationHistoryQueryDto,
  QualificationVersionActionDto,
  UpdateQualificationDto,
} from './dto/qualifications.dto';
import { QualificationsService } from './qualifications.service';
import type { QualificationView } from './qualifications.views';

@ApiTags('qualifications')
@ApiCookieAuth('graduate_session')
@ApiCommonErrorResponses()
@ApiExtraModels(QualificationDto)
@Controller('students/:studentId/qualifications')
export class StudentQualificationsController {
  constructor(private readonly qualifications: QualificationsService) {}

  @Get()
  @ApiOperation({
    summary:
      "List a student's awarded qualifications (degree history; defaults to active qualifications)",
  })
  @ApiPageResponse(
    { $ref: getSchemaPath(QualificationDto) },
    'Paged student qualifications',
  )
  list(
    @Param('studentId', ParsePositiveIntPipe) studentId: number,
    @Query() query: ListStudentQualificationsQueryDto,
  ): Promise<PageResult<QualificationView>> {
    return this.qualifications.listStudentQualifications(studentId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Record an awarded qualification for a student' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiCreatedDataResponse(
    { $ref: getSchemaPath(QualificationDto) },
    'Created qualification record',
  )
  create(
    @CurrentSession() session: AuthenticatedSession,
    @Param('studentId', ParsePositiveIntPipe) studentId: number,
    @Body() body: CreateQualificationDto,
  ): Promise<QualificationView> {
    return this.qualifications.createQualification(
      { staffUserId: session.user.id },
      studentId,
      body,
    );
  }
}

@ApiTags('qualifications')
@ApiCookieAuth('graduate_session')
@ApiCommonErrorResponses()
@ApiExtraModels(QualificationDto, ChangeHistoryEntryDto, HistoryStaffActorDto)
@Controller('qualifications')
export class QualificationsController {
  constructor(private readonly qualifications: QualificationsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a qualification record by ID' })
  @ApiDataResponse(
    { $ref: getSchemaPath(QualificationDto) },
    'Qualification record',
  )
  get(
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: GetQualificationQueryDto,
  ): Promise<QualificationView> {
    return this.qualifications.getQualification(id, {
      includeArchived: query.includeArchived,
    });
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an active qualification record or assess equivalency',
  })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(QualificationDto) },
    'Updated qualification record',
  )
  update(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: UpdateQualificationDto,
  ): Promise<QualificationView> {
    return this.qualifications.updateQualification(
      { staffUserId: session.user.id },
      id,
      body,
    );
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive an active qualification record' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(QualificationDto) },
    'Archived qualification record',
  )
  archive(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: QualificationVersionActionDto,
  ): Promise<QualificationView> {
    return this.qualifications.archiveQualification(
      { staffUserId: session.user.id },
      id,
      body.expectedVersion,
    );
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an archived qualification record' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(QualificationDto) },
    'Restored qualification record',
  )
  restore(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: QualificationVersionActionDto,
  ): Promise<QualificationView> {
    return this.qualifications.restoreQualification(
      { staffUserId: session.user.id },
      id,
      body.expectedVersion,
    );
  }

  @Get(':id/history')
  @ApiOperation({
    summary: 'List change history for a qualification record (newest first)',
  })
  @ApiPageResponse(
    { $ref: getSchemaPath(ChangeHistoryEntryDto) },
    'Paged change history entries',
  )
  history(
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: QualificationHistoryQueryDto,
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    return this.qualifications.getQualificationHistory(id, query);
  }
}
