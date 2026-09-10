import { MessagingProviderRegistry } from '../channels/messaging-provider-registry';
import { WhatsAppCloudMessagingProvider } from '../channels/whatsapp-cloud-messaging-provider';
import { Dependencies } from '../dependencies';
import { SecretResolver } from '../secrets/secret-resolver';
import {
  AIAutomaticOutboundDispatcher,
  PrismaAIAutomaticOutboundStore,
} from './ai-outbound-dispatcher';
import { startAIAutomaticOutboundQueue } from './ai-outbound-queue';

export interface AIAutomaticOutboundRuntimeOptions {
  redisUrl: string;
  whatsappApiVersion: string;
  secretResolver: SecretResolver;
}

/**
 * Composes the live automatic outbound runtime only when a real secret resolver
 * has already been supplied by the server bootstrap. Construction performs no
 * provider I/O; the returned stop function owns queue shutdown.
 */
export async function startAIAutomaticOutboundRuntime(
  deps: Dependencies,
  options: AIAutomaticOutboundRuntimeOptions,
): Promise<() => Promise<void>> {
  const provider = new WhatsAppCloudMessagingProvider(
    options.secretResolver,
    options.whatsappApiVersion,
  );
  const registry = new MessagingProviderRegistry([provider]);
  const dispatcher = new AIAutomaticOutboundDispatcher(
    new PrismaAIAutomaticOutboundStore(deps),
    registry,
    deps,
  );
  return startAIAutomaticOutboundQueue(deps, options.redisUrl, dispatcher);
}
