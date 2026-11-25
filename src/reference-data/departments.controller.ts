import {
  Body,
  Controller,
  Delete,
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
  ApiNoContentResponse,
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
import { PageQueryDto } from '../common/http/page-query.dto';
import { ParsePositiveIntPipe } from '../common/http/parse-positive-int.pipe';
import { CurrentSession } from '../staff-access/current-session.decorator';
import type { AuthenticatedSession } from '../staff-access/staff-auth.service';
import {
  CreateDepartmentDto,
  DeleteCatalogEntryQueryDto,
  DepartmentDto,
  ListDepartmentsQueryDto,
  UpdateDepartmentDto,
} from './dto/reference-data.dto';
import { ReferenceDataService } from './reference-data.service';
import type { DepartmentView } from './reference-data.views';

@ApiTags('departments')
@ApiCookieAuth('graduate_session')
@ApiCommonErrorResponses()
@ApiExtraModels(DepartmentDto, ChangeHistoryEntryDto, HistoryStaffActorDto)
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly referenceData: ReferenceDataService) {}

  @Get()
  @ApiOperation({ summary: 'List and search departments' })
  @ApiPageResponse({ $ref: getSchemaPath(DepartmentDto) }, 'Paged departments')
  list(
    @Query() query: ListDepartmentsQueryDto,
  ): Promise<PageResult<DepartmentView>> {
    return this.referenceData.listDepartments(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a department by ID' })
  @ApiDataResponse({ $ref: getSchemaPath(DepartmentDto) }, 'Department')
  get(@Param('id', ParsePositiveIntPipe) id: number): Promise<DepartmentView> {
    return this.referenceData.getDepartment(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a department under a faculty' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiCreatedDataResponse(
    { $ref: getSchemaPath(DepartmentDto) },
    'Created department',
  )
  create(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: CreateDepartmentDto,
  ): Promise<DepartmentView> {
    return this.referenceData.createDepartment(
      { staffUserId: session.user.id },
      body,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a department' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse({ $ref: getSchemaPath(DepartmentDto) }, 'Updated department')
  update(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: UpdateDepartmentDto,
  ): Promise<DepartmentView> {
    return this.referenceData.updateDepartment(
      { staffUserId: session.user.id },
      id,
      body,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an unused department' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiNoContentResponse({ description: 'Department deleted' })
  remove(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: DeleteCatalogEntryQueryDto,
  ): Promise<void> {
    return this.referenceData.deleteDepartment(
      { staffUserId: session.user.id },
      id,
      query.expectedVersion,
    );
  }

  @Get(':id/history')
  @ApiOperation({
    summary: 'List change history for a department (newest first)',
  })
  @ApiPageResponse(
    { $ref: getSchemaPath(ChangeHistoryEntryDto) },
    'Paged change history entries',
  )
  history(
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: PageQueryDto,
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    return this.referenceData.getDepartmentHistory(id, query);
  }
}
