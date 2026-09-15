# ADR-055 — Registry e executor de tools controlados pelo servidor

## Estado

Aceite para o incremento atual da Phase 5.

## Decisão

As tools disponíveis ao modelo são selecionadas exclusivamente num `ToolRegistry` do backend. Cada registo contém schema público, efeito (`read`, `write` ou `handoff`), capabilities obrigatórias, validator semântico e handler determinístico. O modelo não escolhe tenant, customer, conversation, modo de execução, permissões ou chave de idempotência.

`ToolExecutor` volta a validar IDs, nomes, quantidade, capabilities e argumentos depois da resposta do provider. Injeta contexto confiável e gera a chave `<turnId>:<callId>`. Tools de escrita/handoff só podem ser registadas quando declaram suporte a idempotência. A execução é sequencial, limitada a oito calls e tem timeout por handler. Outputs passam novamente pelos limites JSON antes de regressarem ao ciclo de IA.

Erros expostos ao modelo são códigos fechados, não exceções ou detalhes internos. Tool desconhecida, capability ausente e argumentos inválidos não invocam handlers.

## Consequências e limites

- O LLM continua sem acesso a Prisma, Redis ou providers externos.
- O registry fornece apenas definições escolhidas pelo backend ao `AIGateway`.
- Timeout cancela a espera e sinaliza `AbortSignal`; handlers com efeitos têm de combinar idempotência, transação e verificação do signal. Não se assume rollback de efeitos externos.
- Este incremento entrega a infraestrutura e testes, não os 14 handlers de domínio nem o loop conversacional.
- Auditoria persistente, metering, entitlements e fencing da conversa serão integrados nos incrementos seguintes.
