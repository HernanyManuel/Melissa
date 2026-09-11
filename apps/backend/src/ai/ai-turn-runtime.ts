import { Configuration } from '../config';
import { Dependencies } from '../dependencies';
import { AIContextBuilder } from './ai-context-builder';
import { PrismaAIContextSource } from './ai-context-source';
import { AIGateway } from './ai-gateway';
import { createAIProvider } from './ai-provider-factory';
import { AITurnLedger, PrismaAITurnLedgerRepository } from './ai-turn-ledger';
import { AITurnProcessor, PrismaAITurnDispatchStore } from './ai-turn-processor';
import { startAITurnQueue } from './ai-turn-queue';
import { PrismaBusinessToolReader } from './business-tool-reader';
import { registerBusinessReadTools } from './business-read-tools';
import { ConversationEngine } from './conversation-engine';
import { ConversationTurnCoordinator } from './conversation-turn-coordinator';
import { PrismaConversationFence } from './prisma-conversation-fence';
import { ToolExecutor } from './tool-executor';
import { ToolRegistry } from './tool-registry';

const READ_CAPABILITIES = [
  'business.info.read',
  'business.services.read',
  'business.hours.read',
  'business.staff.read',
] as const;

const READ_TOOLS = [
  'get_business_info',
  'get_services',
  'get_service_details',
  'get_price',
  'get_business_hours',
  'get_staff',
] as const;

type QueueStarter = typeof startAITurnQueue;

/**
 * Composes the live conversation-turn runtime from server-owned dependencies.
 * This function is inert until called by a bootstrap and performs no provider
 * I/O during construction. Only the read-only Phase 5 tools are authorized.
 */
export async function startAITurnRuntime(
  deps: Dependencies,
  config: Configuration,
  startQueue: QueueStarter = startAITurnQueue,
): Promise<() => Promise<void>> {
  const provider = createAIProvider(config);
  if (!provider) throw new Error('AI turn runtime requires an explicit provider');

  const registry = new ToolRegistry();
  registerBusinessReadTools(registry, new PrismaBusinessToolReader(deps));
  const executor = new ToolExecutor(registry);
  const engine = new ConversationEngine(
    new AIGateway(provider),
    executor,
    new PrismaConversationFence(deps),
  );
  const coordinator = new ConversationTurnCoordinator(
    new AIContextBuilder(new PrismaAIContextSource(deps)),
    engine,
    new AITurnLedger(new PrismaAITurnLedgerRepository(deps)),
    registry,
    provider.providerKey,
    config.AI_PROVIDER === 'openai' ? config.OPENAI_MODEL! : 'mock',
  );
  const processor = new AITurnProcessor(
    new PrismaAITurnDispatchStore(deps),
    coordinator,
    READ_CAPABILITIES,
    READ_TOOLS,
  );
  return startQueue(deps, config.REDIS_URL, processor);
}
