# ADR-063 — Dispatcher automático com fencing final

- Estado: aceite
- Data: 2026-09-09

## Contexto

O schema 23 já persiste resposta live, conclusão do turno, usage, intent automático e envelope de dispatch na mesma transação. Faltava a fronteira que transforma um envelope pendente numa chamada a `MessagingProvider` sem confiar em tenant ou payload vindos da fila e sem reutilizar a outbox humana.

O takeover humano pode acontecer depois da criação do intent. Por isso, validar `AI_ACTIVE` apenas no commit da outbox não é suficiente: o processo de envio precisa voltar a verificar `mode_epoch` imediatamente antes do efeito externo. Ao mesmo tempo, uma mensagem que o provider já aceitou não pode ser desfeita por um takeover posterior.

## Decisão

`AIAutomaticOutboundDispatcher` recebe apenas ID opaco e tentativa. `PrismaAIAutomaticOutboundStore` resolve o tenant pelo envelope global `ai_outbound_dispatch` e só lê conteúdo dentro de uma transação com RLS do tenant.

Antes de devolver um claim e novamente imediatamente antes da chamada ao provider, a fronteira exige:

1. dispatch ainda `pending`, tentativa esperada e `next_attempt_at` vencido;
2. mesma conversation/customer do intent;
3. conversation em `AI_ACTIVE` com `mode_epoch` igual ao persistido no intent;
4. conversation não fechada/arquivada e customer não apagado;
5. channel live e ativo.

O dispatcher usa lease Redis por intent e um `attemptId` estável igual ao ID do intent. O provider é resolvido por `MessagingProviderRegistry`; um canal live nunca cai para mock. Ausência de adapter compatível falha fechada e segue a política de retry do envelope, até cinco tentativas com backoff limitado.

Após uma resposta de provider, só um recibo com `providerMessageId` não vazio e `acceptedAt` válido permite marcar o envelope como `accepted`. Estados `accepted`, `rejected`, `retry` e `failed` geram auditoria com actor `ai` e nunca expõem conteúdo no envelope global.

## Consequências

- Takeover ou mudança de epoch antes do efeito externo suprime o envio e marca o envelope como rejeitado/stale.
- A fila não precisa transportar tenant, destinatário nem texto.
- Não há fallback live → mock.
- O mesmo ID é reutilizado em retries do provider, permitindo adapters idempotentes.
- Se o provider aceitar a mensagem e o takeover ocorrer depois, a aplicação regista a aceitação; não promete retirar uma mensagem já aceite externamente.
- Esta decisão cria apenas a fronteira de dispatch. O worker ainda não inicia nenhum consumer de `ai_outbound_dispatch` e não existe adapter live configurado neste incremento; portanto nenhuma mensagem automática real é enviada.
- Retenção, recibos de entrega posteriores à aceitação e operação de dead letters continuam pendentes.
