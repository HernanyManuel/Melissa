export interface InboundTextEvent {
  kind: 'text';
  provider: 'whatsapp';
  accountId: string;
  phoneId: string;
  messageId: string;
  senderId: string;
  timestamp: string;
  text: string;
}

export interface InboundStatusEvent {
  kind: 'status';
  provider: 'whatsapp';
  accountId: string;
  phoneId: string;
  messageId: string;
  recipientId: string;
  timestamp: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
}

export interface InboundResult {
  events: Array<InboundTextEvent | InboundStatusEvent>;
  unsupported: number;
  unsupportedEvents: Array<{
    accountId: string;
    phoneId: string;
    messageId: string;
    timestamp: string;
    category: 'message' | 'status';
    payload: Record<string, unknown>;
  }>;
}

// Transport-only boundary. No tenant IDs, database access or delivery acknowledgement.
export interface InboundProvider {
  verifyChallenge(query: Record<string, unknown>): string;
  decode(rawBody: Buffer, signature: unknown): InboundResult;
}
