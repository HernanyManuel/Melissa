import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { ChannelService } from './channel.service';
import { MockChannelDto } from './channel.dto';

@ApiTags('Channels')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v1/tenants/:tenantId/channels')
export class ChannelController {
  constructor(private readonly channels: ChannelService) {}
  @Get()
  list(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) tenant: string) {
    return this.channels.list(req.actor, tenant);
  }
  @Post('mock')
  create(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Body() body: MockChannelDto,
  ) {
    return this.channels.createMock(req.actor, tenant, body);
  }
  @Post(':id/disconnect')
  @HttpCode(200)
  disconnect(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.channels.disconnect(req.actor, tenant, id);
  }
}
