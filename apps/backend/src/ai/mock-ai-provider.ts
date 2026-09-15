import { AIProvider, AIProviderRequest, AIProviderResponse } from './ai-provider';

type MockResponder = (
  request: AIProviderRequest,
) => AIProviderResponse | Promise<AIProviderResponse>;

/** Test/development provider. It performs no I/O and owns no database dependency. */
export class MockAIProvider implements AIProvider {
  readonly providerKey = 'mock';

  constructor(
    private readonly responder: MockResponder = () => ({
      content: 'Mock response',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  ) {}

  async complete(request: AIProviderRequest): Promise<AIProviderResponse> {
    return structuredClone(await this.responder(structuredClone(request)));
  }
}
