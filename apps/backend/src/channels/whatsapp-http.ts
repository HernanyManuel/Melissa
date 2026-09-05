import {
  Controller,
  Get,
  Post,
  Req,
  Header,
  HttpCode,
  Inject,
  HttpException,
  NotFoundException,
  INestApplication,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response, NextFunction, raw } from 'express';
import { createHash } from 'node:crypto';
import { CONFIG, Configuration } from '../config';
import { Dependencies } from '../dependencies';
import { WhatsAppIngress } from './whatsapp-ingress';
import { WhatsAppInboundProvider, WebhookInputError } from './whatsapp-inbound';
import { createQuarantineKeyring } from './quarantine-keyring';

// Register before Nest's JSON parser. The signature authenticates original bytes, not parsed JSON.
export function configureWhatsAppBody(app: INestApplication, config: Configuration) {
  const parser = raw({ type: 'application/json', limit: '256kb', inflate: false });
  app.use('/webhooks/whatsapp', (req: Request, res: Response, next: NextFunction) => {
    if (config.WHATSAPP_WEBHOOK_ENABLED !== 'true') return next(new NotFoundException());
    parser(req, res, (error: unknown) => {
      if (error) {
        const status =
          typeof error === 'object' && error !== null && 'status' in error ? error.status : 400;
        return next(
          new HttpException(
            'Invalid webhook body',
            status === 413 ? 413 : status === 415 ? 415 : 400,
          ),
        );
      }
      next();
    });
  });
}

@ApiTags('WhatsApp webhook (disabled by default)')
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(
    @Inject(CONFIG) private readonly config: Configuration,
    private readonly deps: Dependencies,
  ) {}

  private async gate() {
    if (this.config.WHATSAPP_WEBHOOK_ENABLED !== 'true') throw new NotFoundException();
    if (
      !this.config.WHATSAPP_APP_SECRET ||
      !this.config.WHATSAPP_VERIFY_TOKEN ||
      !this.config.WHATSAPP_INTEGRATION_KEY
    )
      throw new HttpException('Unavailable', 503);
    const scope = createHash('sha256').update(this.config.WHATSAPP_INTEGRATION_KEY).digest('hex');
    try {
      const count = await this.deps.redis.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
        1,
        `whatsapp-webhook:${scope}`,
      );
      if (Number(count) > this.config.WHATSAPP_WEBHOOK_RATE_LIMIT)
        throw new HttpException('Rate limited', 429);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException('Unavailable', 503);
    }
  }

  @Get()
  @Header('Content-Type', 'text/plain')
  async verify(@Req() req: Request) {
    await this.gate();
    try {
      return new WhatsAppInboundProvider(
        this.config.WHATSAPP_APP_SECRET!,
        this.config.WHATSAPP_VERIFY_TOKEN!,
      ).verifyChallenge(req.query);
    } catch {
      throw new HttpException('Verification failed', 403);
    }
  }

  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  async receive(@Req() req: Request) {
    await this.gate();
    if (!req.is('application/json') || !Buffer.isBuffer(req.body))
      throw new HttpException('Unsupported media type', 415);
    try {
      const keyring = createQuarantineKeyring(this.config);
      const ingress = new WhatsAppIngress(
        this.deps.db,
        this.config.WHATSAPP_INTEGRATION_KEY!,
        this.config.WHATSAPP_APP_SECRET!,
        this.config.WHATSAPP_VERIFY_TOKEN!,
        this.config.MESSAGE_DEBOUNCE_MS,
        keyring.current,
      );
      const receipts = await ingress.receive(req.body, req.headers['x-hub-signature-256']);
      if (!receipts.length) throw new HttpException('No supported event', 503);
      // Never expose receipt IDs or tenant metadata to the unauthenticated transport.
      return 'EVENT_RECEIVED';
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof WebhookInputError)
        throw new HttpException(
          'Invalid webhook',
          error.code === 'signature' ? 403 : error.code === 'size' ? 413 : 400,
        );
      // No success ACK on unknown route/type, archived customer, conflict or persistence failure.
      throw new HttpException('Unavailable', 503);
    }
  }
}
