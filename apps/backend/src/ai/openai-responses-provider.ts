import {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
  AIToolCall,
  JsonObject,
} from './ai-provider';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MAX_RESPONSE_BYTES = 1_000_000;

export interface OpenAIResponsesProviderOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeTokenCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

async function readBounded(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) throw new Error('Response too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Response too large');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function parseArguments(value: unknown): JsonObject {
  if (typeof value !== 'string' || value.length > 12_000) throw new Error('Invalid tool arguments');
  const parsed: unknown = JSON.parse(value);
  const object = record(parsed);
  if (!object) throw new Error('Invalid tool arguments');
  return object as JsonObject;
}

function parseOutput(
  payload: Record<string, unknown>,
): Pick<AIProviderResponse, 'content' | 'toolCalls'> {
  if (!Array.isArray(payload.output)) throw new Error('Invalid provider output');
  const text: string[] = [];
  const toolCalls: AIToolCall[] = [];
  for (const rawItem of payload.output) {
    const item = record(rawItem);
    if (!item) throw new Error('Invalid provider output item');
    if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string')
        throw new Error('Invalid function call');
      toolCalls.push({
        id: item.call_id,
        name: item.name,
        arguments: parseArguments(item.arguments),
      });
      continue;
    }
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const rawContent of item.content) {
      const content = record(rawContent);
      if (!content) throw new Error('Invalid provider content');
      if (content.type === 'refusal') throw new Error('Provider refusal');
      if (content.type === 'output_text' && typeof content.text === 'string')
        text.push(content.text);
    }
  }
  const joined = text.join('');
  if (!joined && toolCalls.length === 0) throw new Error('Empty provider output');
  return { content: joined || null, toolCalls };
}

export class OpenAIResponsesProvider implements AIProvider {
  readonly providerKey = 'openai-responses';
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAIResponsesProviderOptions) {
    if (
      options.apiKey.length < 20 ||
      options.apiKey !== options.apiKey.trim() ||
      !/^[a-zA-Z0-9._:-]{1,128}$/.test(options.model)
    )
      throw new Error('Invalid OpenAI provider configuration');
    this.timeoutMs = options.timeoutMs ?? 45_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 60_000)
      throw new Error('Invalid OpenAI provider timeout');
    this.fetcher = options.fetcher ?? fetch;
  }

  async complete(request: AIProviderRequest): Promise<AIProviderResponse> {
    const response = await this.fetcher(RESPONSES_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model,
        instructions: request.systemPrompt,
        input: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        tools: request.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: true,
        })),
        max_output_tokens: request.maxOutputTokens,
        parallel_tool_calls: false,
        store: false,
      }),
    });
    const raw = await readBounded(response);
    if (!response.ok) throw new Error('OpenAI request failed');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid OpenAI response');
    }
    const payload = record(parsed);
    if (!payload || payload.status !== 'completed') throw new Error('Incomplete OpenAI response');
    const output = parseOutput(payload);
    const usage = record(payload.usage);
    return {
      ...output,
      finishReason: output.toolCalls.length ? 'tool_calls' : 'stop',
      usage: {
        inputTokens: safeTokenCount(usage?.input_tokens),
        outputTokens: safeTokenCount(usage?.output_tokens),
      },
    };
  }
}
