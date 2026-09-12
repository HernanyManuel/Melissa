# ADR-054 — Adapter OpenAI Responses opt-in

## Estado

Aceite para o incremento atual da Phase 5.

## Decisão

O primeiro adapter real de `AIProvider` usa a Responses API por HTTP server-side. O endpoint é fixo, o modelo é configuração explícita, `store` é falso e function tools são enviadas com `strict: true`. Chamadas paralelas ficam desativadas para manter execução determinística nesta fase.

`AI_PROVIDER` tem três estados: `disabled` por omissão, `mock` para desenvolvimento/testes e `openai` apenas com chave e modelo completos. Não existe fallback silencioso de OpenAI para mock. A chave nunca entra no domínio, Flutter, logs, erros ou corpo do pedido.

O adapter limita timeout e resposta, não segue redirects, aceita apenas respostas concluídas e converte texto/tool calls para o contrato neutral. Não executa tools; essa responsabilidade permanece num executor backend futuro, depois de autorização, isolamento e validação.

## Consequências

- Uma alteração do formato upstream fica isolada no adapter.
- A seleção de modelo não fica hardcoded no domínio.
- `store: false` reduz retenção remota por omissão, sem substituir a política contratual do fornecedor.
- Refusals, respostas incompletas e payloads malformados falham fechados neste incremento.
- Não foram efetuadas chamadas reais nem configuradas credenciais; staging e metering continuam pendentes.

## Referências

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
