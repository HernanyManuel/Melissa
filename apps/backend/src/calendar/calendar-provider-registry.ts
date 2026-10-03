import { CalendarProvider, CalendarProviderUnavailable } from './calendar-provider';

const PROVIDER_KEY = /^[a-z][a-z0-9_-]{0,31}$/;

export class CalendarProviderRegistry {
  private readonly providers = new Map<string, CalendarProvider>();

  register(provider: CalendarProvider): void {
    if (!PROVIDER_KEY.test(provider.providerKey) || this.providers.has(provider.providerKey))
      throw new Error('Invalid calendar provider registration');
    this.providers.set(provider.providerKey, provider);
  }

  get(providerKey: string): CalendarProvider {
    const provider = this.providers.get(providerKey);
    if (!provider) throw new CalendarProviderUnavailable();
    return provider;
  }

  keys(): string[] {
    return [...this.providers.keys()].sort();
  }
}
