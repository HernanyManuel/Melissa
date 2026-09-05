# ADR-030 — Abstração de fornecedor de mensagens outbound

Estado: fundação parcial da Phase 4; ainda não ligada ao fluxo de envio.

## Contrato

`MessagingProvider.sendText` recebe um attemptId estável, uma referência de destinatário com âmbito do fornecedor e texto. Devolve providerMessageId e acceptedAt. O contrato não concede acesso à base de dados, tenant, credenciais ou controllers. Adapters recebem apenas o necessário para o envio.

`MessagingProviderRegistry` escolhe por modo/tipo de canal. Neste incremento, apenas canal whatsapp/mock/active resolve para MockMessagingProvider. Canal live, desligado, tipo desconhecido ou adapter ausente falha fechado com MessagingProviderUnavailable. Nunca há fallback live → mock.

## Mock e idempotência

MockMessagingProvider não usa rede nem envia WhatsApp. Instala uma Promise no mapa antes de ceder controlo, para que chamadas concorrentes com o mesmo attemptId partilhem uma entrega. O providerMessageId é determinístico `mock:{attemptId}`. Reutilizar o mesmo ID com destinatário/texto diferentes lança ProviderPayloadConflict; o hash SHA-256 evita guardar uma segunda cópia do payload no índice de dedupe.

O mapa é apenas de processo e não é durabilidade. Reiniciar perde essa memória. A futura outbox terá de persistir attemptId/payload hash/resultado antes de usar este adapter; idempotência real não pode depender do mock em memória.

## Segurança e limites

Referência de destinatário e texto não podem ser registados ou devolvidos ao frontend por esta camada. O mock é apenas development/test. O adapter WhatsApp real deverá obter credenciais server-side, aplicar timeouts, classificar erros e preservar o mesmo attemptId conforme o protocolo do fornecedor.

Testes cobrem 20 chamadas concorrentes, resultado estável, conflito de payload, chave duplicada e bloqueio de live/desligado/tipo desconhecido. Ainda não existe API/outbox/worker outbound, UI de envio, callback/correlação ou adapter Meta. Nenhuma mensagem pode ser enviada através desta fundação isolada. Sem migration, credenciais, merge ou deploy; CI no PR #5.
