import { createHash } from 'node:crypto';
import {
  MessagingProvider,
  OutboundText,
  ProviderDelivery,
  ProviderPayloadConflict,
} from './messaging-provider';

interface StoredDelivery extends ProviderDelivery {
  payloadHash: string;
}

/** Development/test provider. It performs no network, phone or WhatsApp operation. */
export class MockMessagingProvider implements MessagingProvider {
  readonly key = 'mock';
  private readonly deliveries = new Map<string, Promise<StoredDelivery>>();

  sendText(input: OutboundText): Promise<ProviderDelivery> {
    const payloadHash = createHash('sha256')
      .update(JSON.stringify([input.recipientReference, input.text]))
      .digest('hex');
    const existing = this.deliveries.get(input.attemptId);
    if (existing)
      return existing.then((delivery) => {
        if (delivery.payloadHash !== payloadHash) throw new ProviderPayloadConflict();
        return delivery;
      });

    // Install the promise before yielding so concurrent callers share one delivery.
    const delivery = Promise.resolve({
      payloadHash,
      providerMessageId: `mock:${input.attemptId}`,
      acceptedAt: new Date(),
    });
    this.deliveries.set(input.attemptId, delivery);
    return delivery;
  }
}
