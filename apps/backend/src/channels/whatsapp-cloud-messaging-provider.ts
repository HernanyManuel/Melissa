import {
  MessagingDeliveryUnknown,
  MessagingProvider,
  MessagingProviderUnavailable,
  OutboundText,
  ProviderDelivery,
} from './messaging-provider';
import { SecretResolver, validateSecretReference } from '../secrets/secret-resolver';

type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

const VERSION = /^v[1-9][0-9]*\.[0-9]+$/;
const PHONE_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const RECIPIENT = /^\+[1-9][0-9]{6,15}$/;
const MAX_RESPONSE_BYTES = 65536;

interface GraphResponse {
  messages?: Array<{ id?: unknown }>;
}

/** Live WhatsApp transport. Construction alone performs no network or secret access. */
export class WhatsAppCloudMessagingProvider implements MessagingProvider {
  readonly key = 'whatsapp:live';

  constructor(
    private readonly secrets: SecretResolver,
    private readonly apiVersion: string,
    private readonly timeoutMs = 15000,
    private readonly fetcher: HttpFetch = fetch,
  ) {
    if (!VERSION.test(apiVersion) || timeoutMs < 100 || timeoutMs > 60000)
      throw new Error('Invalid WhatsApp messaging configuration');
  }

  async sendText(input: OutboundText): Promise<ProviderDelivery> {
    if (
      !input.senderReference ||
      !PHONE_ID.test(input.senderReference) ||
      !input.credentialsReference ||
      !RECIPIENT.test(input.recipientReference) ||
      input.text.length < 1 ||
      input.text.length > 4096
    )
      throw new MessagingProviderUnavailable();

    const reference = validateSecretReference(input.credentialsReference);
    const token = await this.secrets.resolve(reference);
    if (token.length < 16 || token.length > 4096 || token !== token.trim())
      throw new MessagingProviderUnavailable();

    let response: Response;
    try {
      response = await this.fetcher(
        `https://graph.facebook.com/${this.apiVersion}/${encodeURIComponent(input.senderReference)}/messages`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: input.recipientReference,
            type: 'text',
            text: { body: input.text, preview_url: false },
          }),
        },
      );
    } catch {
      throw new MessagingDeliveryUnknown();
    }

    // Once the request reached the live provider, any non-success or malformed receipt is ambiguous.
    if (!response.ok) throw new MessagingDeliveryUnknown();
    try {
      const raw = await this.readBounded(response);
      const payload = JSON.parse(raw) as GraphResponse;
      const providerMessageId = payload.messages?.[0]?.id;
      if (typeof providerMessageId !== 'string' || providerMessageId.length < 1)
        throw new Error('Invalid provider receipt');
      return { providerMessageId, acceptedAt: new Date() };
    } catch {
      throw new MessagingDeliveryUnknown();
    }
  }

  private async readBounded(response: Response): Promise<string> {
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))
      throw new Error('Provider body too large');
    if (!response.body) throw new Error('Missing provider body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error('Provider body too large');
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
