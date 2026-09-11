import { BookingEngine } from '../booking/booking-engine';
import { Configuration } from '../config';
import { Dependencies } from '../dependencies';
import { AIContextBuilder } from './ai-context-builder';
import { PrismaAIContextSource } from './ai-context-source';
import { AIGateway } from './ai-gateway';
import { createAIProvider } from './ai-provider-factory';
import { AITurnLedger, PrismaAITurnLedgerRepository } from './ai-turn-ledger';
import { AITurnProcessor, PrismaAITurnDispatchStore } from './ai-turn-processor';
import { startAITurnQueue } from './ai-turn-queue';
import { registerAvailableSlotsTool } from './available-slots-tool';
import { PrismaBusinessToolReader } from './business-tool-reader';
import { registerBusinessReadTools } from './business-read-tools';
import { ConversationEngine } from './conversation-engine';
import { ConversationTurnCoordinator } from './conversation-turn-coordinator';
import { registerCreateBookingTool } from './create-booking-tool';
import { PrismaLeadCreator, registerCreateLeadTool } from './create-lead-tool';
import { PrismaBookingReader, registerGetBookingTool } from './get-booking-tool';
import { PrismaHumanHandoff, registerHumanHandoffTool } from './human-handoff-tool';
import { PrismaConversationFence } from './prisma-conversation-fence';
import { ToolExecutor } from './tool-executor';
import { ToolRegistry } from './tool-registry';
import { PrismaCustomerUpdater, registerUpdateCustomerTool } from './update-customer-tool';

const TOOL_CAPABILITIES = [
  'business.info.read',
  'business.services.read',
  'business.hours.read',
  'business.staff.read',
  'booking.availability.read',
  'booking.read',
  'booking.create',
  'conversation.handoff',
  'customer.profile.write',
  'customer.lead.create',
] as const;

const TOOLS = [
  'get_business_info',
  'get_services',
  'get_service_details',
  'get_price',
  'get_business_hours',
  'get_staff',
  'get_available_slots',
  'get_booking',
  'create_booking',
  'human_handoff',
  'update_customer',
  'create_lead',
] as const;

type QueueStarter = typeof startAITurnQueue;

/**
 * Composes the live conversation-turn runtime from server-owned dependencies.
 * This function is inert until called by a bootstrap and performs no provider
 * I/O during construction. Only implemented, server-owned Phase 5 tools are authorized.
 */
export async function startAITurnRuntime(
  deps: Dependencies,
  config: Configuration,
  startQueue: QueueStarter = startAITurnQueue,
): Promise<() => Promise<void>> {
  const provider = createAIProvider(config);
  if (!provider) throw new Error('AI turn runtime requires an explicit provider');

  const registry = new ToolRegistry();
  const bookingEngine = new BookingEngine(deps);
  registerBusinessReadTools(registry, new PrismaBusinessToolReader(deps));
  registerAvailableSlotsTool(registry, bookingEngine);
  registerGetBookingTool(registry, new PrismaBookingReader(deps));
  registerCreateBookingTool(registry, bookingEngine);
  registerHumanHandoffTool(registry, new PrismaHumanHandoff(deps));
  registerUpdateCustomerTool(registry, new PrismaCustomerUpdater(deps));
  registerCreateLeadTool(registry, new PrismaLeadCreator(deps));
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
    TOOL_CAPABILITIES,
    TOOLS,
  );
  return startQueue(deps, config.REDIS_URL, processor);
}
