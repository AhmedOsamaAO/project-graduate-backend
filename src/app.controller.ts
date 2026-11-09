import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppService, type AppIdentity } from './app.service';
import {
  ApiCommonErrorResponses,
  ApiDataResponse,
} from './common/http/api-response.decorators';

@ApiTags('app')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: 'Identify the service' })
  @ApiDataResponse(
    {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string', example: 'Hello World!' },
      },
    },
    'Service identity',
  )
  @ApiCommonErrorResponses()
  getHello(): AppIdentity {
    return this.appService.getHello();
  }
}
