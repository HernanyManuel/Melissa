export interface OutboundText {
  /** Stable server-owned ID reused across provider retries. */
  attemptId: string;
  /** Provider-scoped recipient reference; never log or return it to frontend clients. */
  recipientReference: string;
  text: string;
}

export interface ProviderDelivery {
  providerMessageId: string;
  acceptedAt: Date;
}

export interface MessagingProvider {
  readonly key: string;
  sendText(input: OutboundText): Promise<ProviderDelivery>;
}

export class ProviderPayloadConflict extends Error {
  constructor() {
    super('Provider attempt ID was reused with a different payload');
    this.name = 'ProviderPayloadConflict';
  }
}

export class MessagingProviderUnavailable extends Error {
  constructor() {
    super('No messaging provider is configured for this channel');
    this.name = 'MessagingProviderUnavailable';
  }
}
