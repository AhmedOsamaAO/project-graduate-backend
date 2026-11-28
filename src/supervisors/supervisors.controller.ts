import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
import { PageQueryDto } from '../common/http/page-query.dto';
import { ParsePositiveIntPipe } from '../common/http/parse-positive-int.pipe';
import { CurrentSession } from '../staff-access/current-session.decorator';
import type { AuthenticatedSession } from '../staff-access/staff-auth.service';
import {
  CreateSupervisorDto,
  ListSupervisorsQueryDto,
  SupervisorDto,
  SupervisorVersionActionDto,
  UpdateSupervisorDto,
  UpdateSupervisorExternalApprovalDto,
} from './dto/supervisors.dto';
import { SupervisorsService } from './supervisors.service';
import type { SupervisorView } from './supervisors.views';

@ApiTags('supervisors')
@ApiCookieAuth('graduate_session')
@ApiCommonErrorResponses()
@ApiExtraModels(SupervisorDto, ChangeHistoryEntryDto, HistoryStaffActorDto)
@Controller('supervisors')
export class SupervisorsController {
  constructor(private readonly supervisors: SupervisorsService) {}

  @Get()
  @ApiOperation({
    summary: 'List and search internal and external supervisors',
  })
  @ApiPageResponse({ $ref: getSchemaPath(SupervisorDto) }, 'Paged supervisors')
  list(
    @Query() query: ListSupervisorsQueryDto,
  ): Promise<PageResult<SupervisorView>> {
    return this.supervisors.listSupervisors(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a supervisor record by ID' })
  @ApiDataResponse({ $ref: getSchemaPath(SupervisorDto) }, 'Supervisor record')
  get(@Param('id', ParsePositiveIntPipe) id: number): Promise<SupervisorView> {
    return this.supervisors.getSupervisor(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an internal or external supervisor record' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiCreatedDataResponse(
    { $ref: getSchemaPath(SupervisorDto) },
    'Created supervisor record',
  )
  create(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: CreateSupervisorDto,
  ): Promise<SupervisorView> {
    return this.supervisors.createSupervisor(
      { staffUserId: session.user.id },
      body,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a supervisor record' })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(SupervisorDto) },
    'Updated supervisor record',
  )
  update(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: UpdateSupervisorDto,
  ): Promise<SupervisorView> {
    return this.supervisors.updateSupervisor(
      { staffUserId: session.user.id },
      id,
      body,
    );
  }

  @Put(':id/external-approval')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve, reject, or reset external supervisor approval status',
  })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(SupervisorDto) },
    'Updated external supervisor approval state',
  )
  updateExternalApproval(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: UpdateSupervisorExternalApprovalDto,
  ): Promise<SupervisorView> {
    return this.supervisors.updateExternalApproval(
      { staffUserId: session.user.id },
      id,
      body,
    );
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Deactivate a supervisor to block new assignments while retaining existing references',
  })
  @ApiHeader({
    name: 'X-CSRF-Token',
    required: true,
    description: 'Active session CSRF token',
  })
  @ApiDataResponse(
    { $ref: getSchemaPath(SupervisorDto) },
    'Deactivated supervisor record',
  )
  deactivate(
    @CurrentSession() session: AuthenticatedSession,
    @Param('id', ParsePositiveIntPipe) id: number,
    @Body() body: SupervisorVersionActionDto,
  ): Promise<SupervisorView> {
    return this.supervisors.deactivateSupervisor(
      { staffUserId: session.user.id },
      id,
      body.expectedVersion,
    );
  }

  @Get(':id/history')
  @ApiOperation({
    summary: 'List change history for a supervisor record (newest first)',
  })
  @ApiPageResponse(
    { $ref: getSchemaPath(ChangeHistoryEntryDto) },
    'Paged change history entries',
  )
  history(
    @Param('id', ParsePositiveIntPipe) id: number,
    @Query() query: PageQueryDto,
  ): Promise<PageResult<ChangeHistoryEntryView>> {
    return this.supervisors.getSupervisorHistory(id, query);
  }
}
