import { MessagingProvider, MessagingProviderUnavailable } from './messaging-provider';

export interface ProviderChannel {
  mode: string;
  channelType: string;
  status: string;
}

export class MessagingProviderRegistry {
  private readonly providers: ReadonlyMap<string, MessagingProvider>;

  constructor(providers: readonly MessagingProvider[]) {
    const entries = providers.map((provider) => [provider.key, provider] as const);
    if (new Set(entries.map(([key]) => key)).size !== entries.length)
      throw new Error('Duplicate messaging provider key');
    this.providers = new Map(entries);
  }

  resolve(channel: ProviderChannel): MessagingProvider {
    if (channel.status !== 'active') throw new MessagingProviderUnavailable();
    // A live WhatsApp channel never falls back to mock or any other adapter.
    const key =
      channel.mode === 'mock' && channel.channelType === 'whatsapp'
        ? 'mock'
        : `${channel.channelType}:${channel.mode}`;
    const provider = this.providers.get(key);
    if (!provider) throw new MessagingProviderUnavailable();
    return provider;
  }
}
