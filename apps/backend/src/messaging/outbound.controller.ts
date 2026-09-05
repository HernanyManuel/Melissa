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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiOkResponse,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { OutboundIntentService } from './outbound-intent.service';
import { OutboundRateLimitGuard } from './outbound-rate-limit';
import {
  OutboundErrorDto,
  StoredOutboundDto,
  StoreMockOutboundDto,
  StoreMockOutboundResponseDto,
} from './outbound.dto';

@ApiTags('Messaging sandbox')
@ApiBearerAuth()
@UseGuards(AuthGuard, OutboundRateLimitGuard)
@ApiResponse({
  status: 429,
  description:
    'Per-user fixed 60-second window: 30 POSTs or 120 GETs, independent across operations. Retries also count. Wait Retry-After seconds and reuse the same requestId.',
  type: OutboundErrorDto,
  headers: {
    'Retry-After': {
      description: 'Seconds until the current window expires.',
      schema: { type: 'integer', minimum: 1 },
    },
  },
})
@ApiResponse({
  status: 503,
  description: 'Rate limiter unavailable; no intent is stored by this request.',
  type: OutboundErrorDto,
})
@ApiParam({ name: 'tenantId', format: 'uuid', required: true })
@ApiResponse({
  status: 400,
  description: 'Invalid identifiers or request body.',
  type: OutboundErrorDto,
})
@ApiResponse({ status: 401, description: 'Authentication required.', type: OutboundErrorDto })
@ApiResponse({
  status: 403,
  description: 'Owner/admin permission required.',
  type: OutboundErrorDto,
})
@ApiResponse({
  status: 404,
  description: 'Tenant or resource absent/inaccessible; new intent target may be ineligible.',
  type: OutboundErrorDto,
})
@ApiResponse({
  status: 500,
  description:
    'Sanitized failure; storage outcome may be uncertain. Retry identical request, not a new key.',
  type: OutboundErrorDto,
})
@Controller('api/v1/tenants/:tenantId')
export class OutboundController {
  constructor(private readonly outbound: OutboundIntentService) {}

  @Post('conversations/:id/mock-outbound-intents')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid', required: true })
  @ApiOperation({
    operationId: 'storeMockOutboundIntent',
    summary: 'Queue a mock outbound intent without real delivery',
    description:
      'Owner/admin sandbox only. HTTP 200 means durable acceptance or an identical replay; state describes current mock processing. It never means a WhatsApp send or delivery. Reuse requestId and exact text after uncertain responses. 1000 intents per tenant; replay remains available at capacity.',
  })
  @ApiOkResponse({ type: StoreMockOutboundResponseDto })
  @ApiResponse({
    status: 409,
    description:
      'Same request key with different text/conversation, or sandbox storage capacity reached.',
    type: OutboundErrorDto,
  })
  store(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() body: StoreMockOutboundDto,
  ) {
    return this.outbound.acceptMock(req.actor, tenantId, { ...body, conversationId });
  }

  @Get('outbound-intents/:id')
  @ApiParam({ name: 'id', format: 'uuid', required: true })
  @ApiOperation({
    operationId: 'getStoredOutboundIntent',
    summary: 'Read minimal mock processing receipt',
    description:
      'Owner/admin in the authorized tenant can read mock queue state, including intents from another operator. No content, actor, recipient, attempts, provider identifier or real delivery state is returned. This GET never submits or requeues.',
  })
  @ApiOkResponse({ type: StoredOutboundDto })
  receipt(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.outbound.receipt(req.actor, tenantId, id);
  }
}
