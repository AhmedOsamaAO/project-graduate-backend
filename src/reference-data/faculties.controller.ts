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
  CreateFacultyDto,
  DeleteCatalogEntryQueryDto,
  FacultyDto,
  ListFacultiesQueryDto,
  UpdateFacultyDto,
} from './dto/reference-data.dto';
import { ReferenceDataService } from './reference-data.service';
import type { FacultyView } from './reference-data.views';

@ApiTags('faculties')
@ApiCookieAuth('graduate_session')
@ApiCommonErrorResponses()
@ApiExtraModels(FacultyDto, ChangeHistoryEntryDto, HistoryStaffActorDto)
@Controller('faculties')
export class FacultiesController {
  constructor(private readonly referenceData: ReferenceDataService) {}

  @Get()
  @ApiOperation({ summary: 'List and search faculties' })
  @ApiPageResponse({ $ref: getSchemaPath(FacultyDto) }, 'Paged faculties')
  list(
    @Query() query: ListFacultiesQueryDto,
  ): Promise<PageResult<FacultyView>> {
    return this.referenceData.listFaculties(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a faculty by ID' })
  @ApiDataResponse({ $ref: getSchemaPath(FacultyDto) }, 'Faculty')
  get(@Param('id', ParsePositiveIntPipe) id: number): Promise<FacultyView> {
    return this.referenceData.getFaculty(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a faculty under an educational institution',
  })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiCreatedDataResponse(
    { $ref: getSchemaPath(FacultyDto) },
    'Created faculty',
  )
  create(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: CreateFacultyDto,
  ): Promise<FacultyView> {
    return this.referenceData.createFaculty(
      { staffUserId: session.user.id },
      body,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a non-fixed faculty' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse({ $ref: getSchemaPath(FacultyDto) }, 'Updated faculty')
  update(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: UpdateFacultyDto,
  ): Promise<FacultyView> {
    return this.referenceData.updateFaculty(
      { staffUserId: session.user.id },
      id,
      body,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an unused non-fixed faculty' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiNoContentResponse({ description: 'Faculty deleted' })
  remove(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: DeleteCatalogEntryQueryDto,
  ): Promise<void> {
    return this.referenceData.deleteFaculty(
      { staffUserId: session.user.id },
      id,
      query.expectedVersion,
    );
  }

  @Get(':id/history')
  @ApiOperation({
    summary: 'List change history for a faculty (newest first)',
  })
  @ApiPageResponse(
    { $ref: getSchemaPath(ChangeHistoryEntryDto) },
    'Paged change history entries',
  )
  history(
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: PageQueryDto,
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    return this.referenceData.getFacultyHistory(id, query);
  }
}
