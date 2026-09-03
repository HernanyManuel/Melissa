import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiResponse, ApiOperation } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { MessagingService } from './messaging.service';
import { MessagePageDto, MockInboundDto } from './dto';

@ApiTags('Messaging sandbox')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v1/tenants/:tenantId')
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}
  @Post('channels/:id/mock-inbound')
  @HttpCode(202)
  receive(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MockInboundDto,
  ) {
    return this.messaging.receiveMock(req.actor, tenant, id, body);
  }
  @Get('conversations')
  conversations(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Query() page: MessagePageDto,
  ) {
    return this.messaging.conversations(req.actor, tenant, page);
  }
  @Get('message-receipts/:id')
  @ApiOperation({
    summary: 'Read an accepted inbound message receipt',
    description:
      'Only mock/WhatsApp message.received events. Quarantine and delivery-status events are not message receipts. Missing or inconsistent processing evidence never implies success.',
  })
  @ApiResponse({
    status: 404,
    description: 'Event absent, inaccessible or not an inbound message receipt.',
  })
  @ApiResponse({
    status: 503,
    description:
      'TEMPORARILY_UNAVAILABLE: incomplete/inconsistent receipt evidence. Retry the GET; do not send a new message to repair this condition.',
  })
  receipt(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.messaging.receipt(req.actor, tenant, id);
  }
  @Get('conversations/:id/messages')
  messages(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() page: MessagePageDto,
  ) {
    return this.messaging.messages(req.actor, tenant, id, page);
  }
}
