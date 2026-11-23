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
  CreateInstitutionDto,
  DeleteCatalogEntryQueryDto,
  EducationalInstitutionDto,
  ListInstitutionsQueryDto,
  UpdateInstitutionDto,
} from './dto/reference-data.dto';
import { ReferenceDataService } from './reference-data.service';
import type { EducationalInstitutionView } from './reference-data.views';

@ApiTags('institutions')
@ApiCookieAuth('graduate_session')
@ApiCommonErrorResponses()
@ApiExtraModels(
  EducationalInstitutionDto,
  ChangeHistoryEntryDto,
  HistoryStaffActorDto,
)
@Controller('institutions')
export class InstitutionsController {
  constructor(private readonly referenceData: ReferenceDataService) {}

  @Get()
  @ApiOperation({ summary: 'List and search educational institutions' })
  @ApiPageResponse(
    { $ref: getSchemaPath(EducationalInstitutionDto) },
    'Paged educational institutions',
  )
  list(
    @Query() query: ListInstitutionsQueryDto,
  ): Promise<PageResult<EducationalInstitutionView>> {
    return this.referenceData.listInstitutions(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an educational institution by ID' })
  @ApiDataResponse(
    { $ref: getSchemaPath(EducationalInstitutionDto) },
    'Educational institution',
  )
  get(
    @Param('id', ParsePositiveIntPipe) id: number,
  ): Promise<EducationalInstitutionView> {
    return this.referenceData.getInstitution(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an educational institution' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiCreatedDataResponse(
    { $ref: getSchemaPath(EducationalInstitutionDto) },
    'Created educational institution',
  )
  create(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: CreateInstitutionDto,
  ): Promise<EducationalInstitutionView> {
    return this.referenceData.createInstitution(
      { staffUserId: session.user.id },
      body,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a non-fixed educational institution' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(EducationalInstitutionDto) },
    'Updated educational institution',
  )
  update(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: UpdateInstitutionDto,
  ): Promise<EducationalInstitutionView> {
    return this.referenceData.updateInstitution(
      { staffUserId: session.user.id },
      id,
      body,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an unused non-fixed educational institution',
  })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiNoContentResponse({ description: 'Educational institution deleted' })
  remove(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: DeleteCatalogEntryQueryDto,
  ): Promise<void> {
    return this.referenceData.deleteInstitution(
      { staffUserId: session.user.id },
      id,
      query.expectedVersion,
    );
  }

  @Get(':id/history')
  @ApiOperation({
    summary:
      'List change history for an educational institution (newest first)',
  })
  @ApiPageResponse(
    { $ref: getSchemaPath(ChangeHistoryEntryDto) },
    'Paged change history entries',
  )
  history(
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: PageQueryDto,
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    return this.referenceData.getInstitutionHistory(id, query);
  }
}
