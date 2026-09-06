import { AIToolDefinition, JsonObject, JsonValue } from './ai-provider';
import { assertSafeJson } from './json-safety';

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CAPABILITY = /^[a-z][a-z0-9_.:-]{0,127}$/;

export type ToolEffect = 'read' | 'write' | 'handoff';

export interface ToolExecutionContext {
  tenantId: string;
  customerId: string;
  conversationId: string;
  correlationId: string;
  turnId: string;
  executionMode: 'live' | 'sandbox';
  idempotencyKey: string;
}

export interface ToolRegistration {
  definition: AIToolDefinition;
  effect: ToolEffect;
  requiredCapabilities: readonly string[];
  supportsIdempotency: boolean;
  validateArguments(value: JsonObject): JsonObject;
  execute(
    context: Readonly<ToolExecutionContext>,
    arguments_: Readonly<JsonObject>,
    signal: AbortSignal,
  ): Promise<JsonValue>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>();

  register(registration: ToolRegistration): void {
    const { definition } = registration;
    if (
      !TOOL_NAME.test(definition.name) ||
      this.tools.has(definition.name) ||
      !definition.description ||
      definition.description.length > 1000 ||
      !registration.requiredCapabilities.length ||
      registration.requiredCapabilities.some((item) => !CAPABILITY.test(item)) ||
      ((registration.effect === 'write' || registration.effect === 'handoff') &&
        !registration.supportsIdempotency)
    )
      throw new Error('Invalid tool registration');
    assertSafeJson(definition.inputSchema);
    if (JSON.stringify(definition.inputSchema).length > 12_000)
      throw new Error('Tool schema too large');
    this.tools.set(definition.name, {
      ...registration,
      definition: structuredClone(definition),
      requiredCapabilities: [...new Set(registration.requiredCapabilities)],
    });
  }

  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  definitions(names: readonly string[]): AIToolDefinition[] {
    if (new Set(names).size !== names.length) throw new Error('Duplicate tool selection');
    return names.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new Error('Unknown tool selection');
      return structuredClone(tool.definition);
    });
  }
}
