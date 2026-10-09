import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiResponse, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import { Response } from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { MessagingService } from './messaging.service';
import {
  AbandonManualReplyDto,
  ConversationQuery,
  ConversationTakeoverDto,
  CreateInternalNoteDto,
  InboxEventQuery,
  ManualReplyDto,
  MarkConversationReadDto,
  MessagePageDto,
  MockInboundDto,
} from './dto';
import { ProcessingQuery, ProcessingPageDto } from './processing.dto';

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
  @ApiOperation({
    summary: 'List or search conversations',
    description:
      'Optional literal name search q, scoped to the authorized tenant. Fixed pages of 50 ordered by ID. Retain q when following a cursor; reset cursor when changing q.',
  })
  conversations(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Query() page: ConversationQuery,
  ) {
    return this.messaging.conversations(req.actor, tenant, page);
  }
  @Get('conversations/:id/internal-notes')
  @ApiOperation({
    summary: 'List private, append-only notes for a conversation',
    description:
      'Tenant-authorized staff only. Notes never become customer messages or outbound dispatch.',
  })
  internalNotes(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() page: MessagePageDto,
  ) {
    return this.messaging.internalNotes(req.actor, tenant, id, page);
  }

  @Post('conversations/:id/internal-notes')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create one immutable internal note with actor-scoped idempotency',
    description:
      'A repeated requestId with identical content is idempotent; a different payload is 409.',
  })
  createInternalNote(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateInternalNoteDto,
  ) {
    return this.messaging.createInternalNote(req.actor, tenant, id, body);
  }

  @Post('conversations/:id/read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark messages through a previously observed inbound event as read',
    description:
      'Per-actor, per-tenant monotonic cursor. The upTo sequence must identify an inbound event in this conversation; older and duplicate acknowledgements are idempotent. Later messages remain unread.',
  })
  markConversationRead(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MarkConversationReadDto,
  ) {
    return this.messaging.markConversationRead(req.actor, tenant, id, body.upTo);
  }

  @Post('conversations/:id/takeover')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Take over a conversation for a human staff member',
    description:
      'Moves an active conversation to HUMAN_ACTIVE. Staff-role users may only claim a staff record linked to their own user identity.',
  })
  takeover(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ConversationTakeoverDto,
  ) {
    return this.messaging.takeover(req.actor, tenant, id, body.staffId);
  }

  @Post('conversations/:id/reactivate-ai')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reactivate AI after a human takeover',
    description:
      'Moves HUMAN_ACTIVE to AI_ACTIVE, clears the staff assignment and advances the mode fence.',
  })
  reactivateAI(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.messaging.reactivateAI(req.actor, tenant, id);
  }

  @Post('conversations/:id/close')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Close a conversation',
    description:
      'Moves the conversation to CLOSED, clears human assignment and records closedAt. Repeated close is idempotent.',
  })
  closeConversation(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.messaging.closeConversation(req.actor, tenant, id);
  }

  @Get('inbox/events')
  @ApiOperation({
    summary: 'Stream durable tenant-scoped Inbox events',
    description:
      'SSE stream with tenant-local monotonic IDs. Reconnect with Last-Event-ID or the initial after query to replay missed events.',
  })
  async inboxEvents(
    @Req() req: AuthRequest,
    @Res() response: Response,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Query() query: InboxEventQuery,
    @Headers('last-event-id') lastEventId?: string,
  ): Promise<void> {
    let cursor = this.inboxCursor(lastEventId ?? query.after);
    let events = await this.messaging.inboxEvents(req.actor, tenant, cursor);

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    response.write('retry: 2000\n\n');

    let closed = false;
    const closedSignal = new Promise<void>((resolve) => {
      req.once('close', () => {
        closed = true;
        resolve();
      });
    });
    let lastHeartbeat = Date.now();

    while (!closed) {
      for (const event of events) {
        if (closed) break;
        response.write(`id: ${event.sequence}\n`);
        response.write(`event: ${event.eventType}\n`);
        response.write(
          `data: ${JSON.stringify({
            conversationId: event.conversationId,
            messageId: event.messageId,
            createdAt: event.createdAt,
          })}\n\n`,
        );
        cursor = BigInt(event.sequence);
      }
      if (closed) break;

      if (events.length === 100) {
        try {
          events = await this.messaging.inboxEvents(req.actor, tenant, cursor);
          continue;
        } catch {
          break;
        }
      }

      if (Date.now() - lastHeartbeat >= 15_000) {
        response.write(': keep-alive\n\n');
        lastHeartbeat = Date.now();
      }
      await Promise.race([delay(1000), closedSignal]);
      if (closed) break;
      try {
        events = await this.messaging.inboxEvents(req.actor, tenant, cursor);
      } catch {
        break;
      }
    }

    if (!response.writableEnded) response.end();
  }

  private inboxCursor(value?: string): bigint {
    if (value === undefined) return 0n;
    if (!/^\d{1,19}$/.test(value)) throw new BadRequestException();
    const cursor = BigInt(value);
    if (cursor > 9_223_372_036_854_775_807n) throw new BadRequestException();
    return cursor;
  }

  @Get('message-processing')
  @ApiOperation({
    operationId: 'listMessageProcessing',
    summary: 'Read inbound processing metadata',
    description:
      'Owner/admin only. Fixed pages of 50, exclusive ID cursor, no content or identifiers of customers. Changing worker state means pagination is not a snapshot. No retry or cancellation action.',
  })
  @ApiOkResponse({ type: ProcessingPageDto })
  processing(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Query() query: ProcessingQuery,
  ) {
    return this.messaging.processing(req.actor, tenant, query);
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
  @Get('conversations/:id/manual-replies/latest')
  @ApiOperation({
    summary: "Recover the current operator's latest durable manual reply",
    description:
      'Read-only, tenant- and actor-scoped. Returns the original requestId/text and dispatch state, or null if no committed intent exists. Absence cannot prove that an earlier network-uncertain POST will never commit.',
  })
  latestManualReply(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.messaging.latestManualReply(req.actor, tenant, id);
  }

  @Post('conversations/:id/manual-replies/prepare')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Durably prepare a manual reply without queuing a provider send',
    description:
      'Actor-scoped idempotent write of the original requestId and text. Prepared intents have no dispatch row and cannot be sent by the worker until an explicit POST /messages confirms them.',
  })
  prepareReply(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ManualReplyDto,
  ) {
    return this.messaging.prepareReply(req.actor, tenant, id, body);
  }

  @Post('conversations/:id/manual-replies/abandon')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Abandon a prepared manual reply without sending it',
    description:
      'Only the original actor can abandon an intent without a dispatch. Rejected for any queued or in-flight reply. Idempotent for an already abandoned intent.',
  })
  abandonPreparedReply(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AbandonManualReplyDto,
  ) {
    return this.messaging.abandonPreparedReply(req.actor, tenant, id, body.requestId);
  }

  @Post('conversations/:id/messages')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Queue a manual staff reply',
    description:
      'Requires HUMAN_ACTIVE. The requestId is idempotent per actor/tenant. HTTP 200 means durable queue acceptance or identical replay, not provider delivery.',
  })
  reply(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ManualReplyDto,
  ) {
    return this.messaging.reply(req.actor, tenant, id, body);
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
