import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiServiceUnavailableResponse } from '@nestjs/swagger';
import { Dependencies } from './dependencies';

export class HealthResponse {
  @ApiProperty({ enum: ['ok'] })
  status: 'ok' = 'ok';
}

@Controller('health')
export class HealthController {
  constructor(private readonly dependencies: Dependencies) {}

  @Get('live')
  @ApiOkResponse({ type: HealthResponse })
  live(): HealthResponse { return { status: 'ok' }; }

  @Get()
  @ApiOkResponse({ type: HealthResponse })
  @ApiServiceUnavailableResponse({ description: 'Dependencies or migration unavailable.' })
  health(): Promise<HealthResponse> { return this.ready(); }

  @Get('ready')
  @ApiOkResponse({ type: HealthResponse })
  @ApiServiceUnavailableResponse({ description: 'Dependencies or migration unavailable.' })
  async ready(): Promise<HealthResponse> {
    if (!(await this.dependencies.ready())) {
      throw new ServiceUnavailableException('TEMPORARILY_UNAVAILABLE');
    }
    return { status: 'ok' };
  }
}
