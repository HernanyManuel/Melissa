export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIToolCallMessage {
  role: 'tool_call';
  callId: string;
  name: string;
  arguments: JsonObject;
}

export interface AIToolResultMessage {
  role: 'tool_result';
  callId: string;
  name: string;
  result: JsonObject;
}

export type AIInputItem = AIMessage | AIToolCallMessage | AIToolResultMessage;

export interface AIToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface AIProviderRequest {
  systemPrompt: string;
  messages: AIInputItem[];
  tools: AIToolDefinition[];
  maxOutputTokens: number;
}

export interface AIToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface AIProviderResponse {
  content: string | null;
  toolCalls: AIToolCall[];
  finishReason: 'stop' | 'tool_calls';
  usage: { inputTokens: number; outputTokens: number };
}

export interface AIProvider {
  readonly providerKey: string;
  complete(request: AIProviderRequest): Promise<AIProviderResponse>;
}

export class AICompletionFailed extends Error {
  constructor() {
    super('AI completion failed');
    this.name = 'AICompletionFailed';
  }
}
