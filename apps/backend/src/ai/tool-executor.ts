import { isUUID } from 'class-validator';
import { AIToolCall, JsonObject, JsonValue } from './ai-provider';
import { assertSafeJson } from './json-safety';
import { ToolEffect, ToolExecutionContext, ToolRegistry } from './tool-registry';

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CALL_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const CAPABILITY = /^[a-z][a-z0-9_.:-]{0,127}$/;

export type ToolExecutionError =
  | 'unknown_tool'
  | 'forbidden'
  | 'invalid_arguments'
  | 'execution_failed'
  | 'timeout';

export interface ToolExecutionResult {
  callId: string;
  name: string;
  success: boolean;
  output?: JsonValue;
  error?: ToolExecutionError;
}

export interface ToolTurnContext extends Omit<ToolExecutionContext, 'idempotencyKey'> {
  capabilities: readonly string[];
}

export class ToolExecutionRejected extends Error {
  constructor() {
    super('Tool execution rejected');
    this.name = 'ToolExecutionRejected';
  }
}

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly timeoutMs = 5000,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
      throw new Error('Invalid tool timeout');
  }

  effect(name: string): ToolEffect | undefined {
    return this.registry.get(name)?.effect;
  }

  async execute(
    calls: readonly AIToolCall[],
    context: ToolTurnContext,
  ): Promise<ToolExecutionResult[]> {
    this.validateContext(calls, context);
    const allowed = new Set(context.capabilities);
    const results: ToolExecutionResult[] = [];
    for (const call of calls) {
      const registration = this.registry.get(call.name);
      if (!registration) {
        results.push(this.failed(call, 'unknown_tool'));
        continue;
      }
      if (registration.requiredCapabilities.some((capability) => !allowed.has(capability))) {
        results.push(this.failed(call, 'forbidden'));
        continue;
      }
      let arguments_: JsonObject;
      try {
        assertSafeJson(call.arguments);
        arguments_ = registration.validateArguments(structuredClone(call.arguments));
        assertSafeJson(arguments_);
        if (JSON.stringify(arguments_).length > 12_000) throw new Error('Arguments too large');
      } catch {
        results.push(this.failed(call, 'invalid_arguments'));
        continue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const execution = registration.execute(
          Object.freeze({
            tenantId: context.tenantId,
            customerId: context.customerId,
            conversationId: context.conversationId,
            correlationId: context.correlationId,
            turnId: context.turnId,
            expectedModeEpoch: context.expectedModeEpoch,
            executionMode: context.executionMode,
            idempotencyKey: `${context.turnId}:${call.id}`,
          }),
          Object.freeze(structuredClone(arguments_)),
          controller.signal,
        );
        const output = await Promise.race([
          execution,
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener(
              'abort',
              () => reject(new DOMException('Timed out', 'AbortError')),
              { once: true },
            ),
          ),
        ]);
        assertSafeJson(output);
        if (JSON.stringify(output).length > 12_000) throw new Error('Output too large');
        results.push({ callId: call.id, name: call.name, success: true, output });
      } catch (error) {
        results.push(
          this.failed(
            call,
            controller.signal.aborted ||
              (error instanceof DOMException && error.name === 'AbortError')
              ? 'timeout'
              : 'execution_failed',
          ),
        );
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  }

  private validateContext(calls: readonly AIToolCall[], context: ToolTurnContext): void {
    if (
      !Array.isArray(calls) ||
      calls.length > 8 ||
      typeof context.expectedModeEpoch !== 'bigint' ||
      context.expectedModeEpoch < 0n ||
      !['live', 'sandbox'].includes(context.executionMode) ||
      !Array.isArray(context.capabilities) ||
      context.capabilities.some((item) => typeof item !== 'string' || !CAPABILITY.test(item)) ||
      ![
        context.tenantId,
        context.customerId,
        context.conversationId,
        context.correlationId,
        context.turnId,
      ].every((value) => isUUID(value)) ||
      new Set(calls.map((call) => call.id)).size !== calls.length ||
      calls.some(
        (call) =>
          !call ||
          !CALL_ID.test(call.id) ||
          !TOOL_NAME.test(call.name) ||
          !call.arguments ||
          typeof call.arguments !== 'object' ||
          Array.isArray(call.arguments),
      )
    )
      throw new ToolExecutionRejected();
  }

  private failed(call: AIToolCall, error: ToolExecutionError): ToolExecutionResult {
    return { callId: call.id, name: call.name, success: false, error };
  }
}
