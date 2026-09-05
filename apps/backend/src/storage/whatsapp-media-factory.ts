import { Configuration, whatsappMediaHosts } from '../config';
import { MediaSourceProvider } from './media-source-provider';
import { WhatsAppGraphMediaSource } from './whatsapp-graph-media-source';

/** Configuration boundary only. It never falls back to mock or performs a request. */
export function createWhatsAppMediaSource(config: Configuration): MediaSourceProvider | null {
  if (config.WHATSAPP_MEDIA_ENABLED !== 'true') return null;
  if (!config.WHATSAPP_MEDIA_ACCESS_TOKEN || !config.WHATSAPP_MEDIA_API_VERSION)
    throw new Error('Invalid WhatsApp media configuration');
  return new WhatsAppGraphMediaSource(
    config.WHATSAPP_MEDIA_ACCESS_TOKEN,
    config.WHATSAPP_MEDIA_API_VERSION,
    whatsappMediaHosts(config.WHATSAPP_MEDIA_DOWNLOAD_HOSTS),
  );
}
