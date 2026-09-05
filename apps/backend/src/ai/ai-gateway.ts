import { isUUID } from 'class-validator';
import {
  AICompletionFailed,
  AIMessage,
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
  AIToolDefinition,
  JsonValue,
} from './ai-provider';

export interface AIGatewayRequest {
  tenantId: string;
  correlationId: string;
  systemPrompt: string;
  messages: AIMessage[];
  tools: AIToolDefinition[];
  maxOutputTokens?: number;
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CALL_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function validateJson(value: JsonValue, depth = 0): void {
  if (depth > 16) throw new Error('JSON depth exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid JSON number');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('JSON array too large');
    for (const item of value) validateJson(item, depth + 1);
    return;
  }
  if (typeof value !== 'object') throw new Error('Invalid JSON value');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Invalid JSON object');
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error('JSON object too large');
  for (const [key, item] of entries) {
    if (!key || key.length > 128 || FORBIDDEN_KEYS.has(key)) throw new Error('Invalid JSON key');
    validateJson(item, depth + 1);
  }
}

function validateTools(tools: AIToolDefinition[]): void {
  if (!Array.isArray(tools) || tools.length > 32) throw new Error('Invalid AI tools');
  const names = new Set<string>();
  for (const tool of tools) {
    if (
      !tool ||
      !NAME.test(tool.name) ||
      names.has(tool.name) ||
      typeof tool.description !== 'string' ||
      tool.description.length < 1 ||
      tool.description.length > 1000
    )
      throw new Error('Invalid AI tool');
    validateJson(tool.inputSchema);
    if (JSON.stringify(tool.inputSchema).length > 12000)
      throw new Error('AI tool schema too large');
    names.add(tool.name);
  }
}

export class AIGateway {
  constructor(private readonly provider: AIProvider) {
    if (!provider.providerKey || provider.providerKey.length > 64)
      throw new Error('Invalid AI provider');
  }

  async complete(request: AIGatewayRequest): Promise<AIProviderResponse> {
    const providerRequest = this.validateRequest(request);
    try {
      return this.validateResponse(await this.provider.complete(providerRequest), request.tools);
    } catch (error) {
      if (error instanceof AICompletionFailed) throw error;
      throw new AICompletionFailed();
    }
  }

  private validateRequest(request: AIGatewayRequest): AIProviderRequest {
    if (!isUUID(request.tenantId) || !isUUID(request.correlationId)) throw new AICompletionFailed();
    if (
      typeof request.systemPrompt !== 'string' ||
      request.systemPrompt.length < 1 ||
      request.systemPrompt.length > 12000 ||
      !Array.isArray(request.messages) ||
      request.messages.length > 50
    )
      throw new AICompletionFailed();
    let total = request.systemPrompt.length;
    for (const message of request.messages) {
      if (
        !message ||
        !['user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' ||
        message.content.length < 1 ||
        message.content.length > 4000
      )
        throw new AICompletionFailed();
      total += message.content.length;
    }
    if (total > 64000) throw new AICompletionFailed();
    try {
      validateTools(request.tools);
    } catch {
      throw new AICompletionFailed();
    }
    const maxOutputTokens = request.maxOutputTokens ?? 1024;
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096)
      throw new AICompletionFailed();
    // Tenant/correlation IDs stay at the gateway for future metering; providers do not receive them.
    return {
      systemPrompt: request.systemPrompt,
      messages: request.messages.map((message) => ({ ...message })),
      tools: request.tools.map((tool) => ({
        ...tool,
        inputSchema: structuredClone(tool.inputSchema),
      })),
      maxOutputTokens,
    };
  }

  private validateResponse(
    response: AIProviderResponse,
    tools: AIToolDefinition[],
  ): AIProviderResponse {
    if (
      !response ||
      (response.content !== null &&
        (typeof response.content !== 'string' || response.content.length > 12000)) ||
      !Array.isArray(response.toolCalls) ||
      response.toolCalls.length > 8 ||
      !['stop', 'tool_calls'].includes(response.finishReason) ||
      !response.usage ||
      !Number.isSafeInteger(response.usage.inputTokens) ||
      response.usage.inputTokens < 0 ||
      !Number.isSafeInteger(response.usage.outputTokens) ||
      response.usage.outputTokens < 0
    )
      throw new Error('Invalid provider response');
    if (
      (response.finishReason === 'tool_calls') !== response.toolCalls.length > 0 ||
      (response.content === null && response.toolCalls.length === 0)
    )
      throw new Error('Inconsistent provider response');
    const allowed = new Set(tools.map((tool) => tool.name));
    const ids = new Set<string>();
    for (const call of response.toolCalls) {
      if (!call || !CALL_ID.test(call.id) || ids.has(call.id) || !allowed.has(call.name))
        throw new Error('Invalid provider tool call');
      validateJson(call.arguments);
      if (JSON.stringify(call.arguments).length > 12000)
        throw new Error('Tool arguments too large');
      ids.add(call.id);
    }
    return structuredClone(response);
  }
}
