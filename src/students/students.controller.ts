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
  CreateStudentDto,
  GetStudentQueryDto,
  ListStudentsQueryDto,
  StudentDto,
  StudentHistoryQueryDto,
  StudentVersionActionDto,
  UpdateStudentDto,
} from './dto/students.dto';
import { StudentsService } from './students.service';
import type { StudentView } from './students.views';

@ApiTags('students')
@ApiCookieAuth('graduate_session')
@ApiCommonErrorResponses()
@ApiExtraModels(StudentDto, ChangeHistoryEntryDto, HistoryStaffActorDto)
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get()
  @ApiOperation({
    summary: 'List and search student records (defaults to active students)',
  })
  @ApiPageResponse({ $ref: getSchemaPath(StudentDto) }, 'Paged students')
  list(@Query() query: ListStudentsQueryDto): Promise<PageResult<StudentView>> {
    return this.students.listStudents(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a student record by ID' })
  @ApiDataResponse({ $ref: getSchemaPath(StudentDto) }, 'Student record')
  get(
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: GetStudentQueryDto,
  ): Promise<StudentView> {
    return this.students.getStudent(id, {
      includeArchived: query.includeArchived,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a student record' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiCreatedDataResponse(
    { $ref: getSchemaPath(StudentDto) },
    'Created student record',
  )
  create(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: CreateStudentDto,
  ): Promise<StudentView> {
    return this.students.createStudent({ staffUserId: session.user.id }, body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an active student record' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(StudentDto) },
    'Updated student record',
  )
  update(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: UpdateStudentDto,
  ): Promise<StudentView> {
    return this.students.updateStudent(
      { staffUserId: session.user.id },
      id,
      body,
    );
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive an active student record' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(StudentDto) },
    'Archived student record',
  )
  archive(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: StudentVersionActionDto,
  ): Promise<StudentView> {
    return this.students.archiveStudent(
      { staffUserId: session.user.id },
      id,
      body.expectedVersion,
    );
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an archived student record' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(StudentDto) },
    'Restored student record',
  )
  restore(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: StudentVersionActionDto,
  ): Promise<StudentView> {
    return this.students.restoreStudent(
      { staffUserId: session.user.id },
      id,
      body.expectedVersion,
    );
  }

  @Get(':id/history')
  @ApiOperation({
    summary: 'List change history for a student record (newest first)',
  })
  @ApiPageResponse(
    { $ref: getSchemaPath(ChangeHistoryEntryDto) },
    'Paged change history entries',
  )
  history(
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: StudentHistoryQueryDto,
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    return this.students.getStudentHistory(id, query);
  }
}
