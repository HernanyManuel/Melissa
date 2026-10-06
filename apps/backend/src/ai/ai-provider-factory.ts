import { Configuration } from '../config';
import { AIProvider } from './ai-provider';
import { MockAIProvider } from './mock-ai-provider';
import { OpenAIResponsesProvider } from './openai-responses-provider';

export function createAIProvider(config: Configuration, fetcher?: typeof fetch): AIProvider | null {
  if (config.AI_PROVIDER === 'disabled') return null;
  if (config.AI_PROVIDER === 'mock') return new MockAIProvider();
  return new OpenAIResponsesProvider({
    apiKey: config.OPENAI_API_KEY!,
    model: config.OPENAI_MODEL!,
    timeoutMs: config.OPENAI_TIMEOUT_MS,
    fetcher,
  });
}
