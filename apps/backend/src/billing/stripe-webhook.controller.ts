import {
  Controller,
  HttpCode,
  HttpException,
  INestApplication,
  Inject,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response, NextFunction, raw } from 'express';
import { CONFIG, Configuration } from '../config';
import { parseStripeEvent, StripeWebhookInbox } from './stripe-webhook.inbox';
import { verifyStripeSignature } from './stripe-signature';

// Body handling MUST run before the default Nest JSON parser.
// prettier-ignore
export function configureStripeWebhookBody(app: INestApplication, config: Configuration): void {
  const parser = raw({ type: 'application/json', limit: '256kb', inflate: false });
  app.use('/webhooks/stripe', (req: Request, res: Response, next: NextFunction) => {
    if (config.STRIPE_WEBHOOK_ENABLED !== 'true') return next(new NotFoundException());
    parser(req, res, (error: unknown) => {
      if (error) {
        const status = typeof error === 'object' && error !== null && 'status' in error
          ? error.status : 400;
        return next(new HttpException('Invalid webhook body', status === 413 ? 413 : 400));
      }
      next();
    });
  });
}

// prettier-ignore
@ApiTags('Stripe test webhooks (disabled by default)')
@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(
    @Inject(CONFIG) private readonly config: Configuration,
    private readonly inbox: StripeWebhookInbox,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive signed Stripe test-mode events into an immutable inbox',
    description:
      'Default disabled. Verifies raw-body v1 HMAC and 5-minute timestamp, deduplicates test events. Does not create/activate subscriptions or send invoices.',
  })
  async receive(@Req() req: Request): Promise<{ received: boolean }> {
    if (this.config.STRIPE_WEBHOOK_ENABLED !== 'true') throw new NotFoundException();
    if (!this.config.STRIPE_WEBHOOK_SECRET) throw new HttpException('Unavailable', 503);
    if (!req.is('application/json') || !Buffer.isBuffer(req.body))
      throw new HttpException('Unsupported media type', 415);
    if (!verifyStripeSignature(req.body, req.headers['stripe-signature'],
      this.config.STRIPE_WEBHOOK_SECRET))
      throw new HttpException('Invalid signature', 403);
    const event = parseStripeEvent(req.body);
    if (!event) throw new HttpException('Invalid event', 400);
    try {
      await this.inbox.store(req.body, event);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException('Unavailable', 503);
    }
    // Transport ACK only. No payment state / entitlement implied.
    return { received: true };
  }
}
