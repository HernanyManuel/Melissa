import { MessagingProviderRegistry } from '../channels/messaging-provider-registry';
import { WhatsAppCloudMessagingProvider } from '../channels/whatsapp-cloud-messaging-provider';
import { Dependencies } from '../dependencies';
import { SecretResolver } from '../secrets/secret-resolver';
import { HumanOutboundDispatcher, PrismaHumanOutboundStore } from './human-outbound-dispatcher';
import { startHumanOutboundQueue } from './human-outbound-queue';

export interface HumanOutboundRuntimeOptions {
  redisUrl: string;
  whatsappApiVersion: string;
  secretResolver: SecretResolver;
}

type QueueStarter = typeof startHumanOutboundQueue;

export async function startHumanOutboundRuntime(
  deps: Dependencies,
  options: HumanOutboundRuntimeOptions,
  startQueue: QueueStarter = startHumanOutboundQueue,
): Promise<() => Promise<void>> {
  const provider = new WhatsAppCloudMessagingProvider(
    options.secretResolver,
    options.whatsappApiVersion,
  );
  const registry = new MessagingProviderRegistry([provider]);
  const dispatcher = new HumanOutboundDispatcher(
    new PrismaHumanOutboundStore(deps),
    registry,
    deps,
  );
  return startQueue(deps, options.redisUrl, dispatcher);
}
