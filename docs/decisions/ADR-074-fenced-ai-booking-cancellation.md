# ADR-074 — Cancelamento de booking confirmado, fenced e idempotente pela IA

## Estado

Proposto.

## Contexto

Depois de `create_booking` e `get_booking`, a IA precisa poder cancelar uma reserva existente sem transformar um identificador de booking em autorização implícita nem permitir mutações fora do contexto confiável da conversa.

Cancelamento é uma operação de write com efeito durável. Por isso deve preservar as mesmas fronteiras já usadas nas restantes tools mutáveis: tenant/customer/conversation/turn/epoch e idempotency key são server-owned, o modo tem de ser live, a conversa tem de continuar em `AI_ACTIVE` no epoch esperado e o booking tem de pertencer ao customer da conversa. O modelo só pode fornecer o identificador do booking, uma razão opcional e confirmação explícita.

Também é necessário distinguir replay idempotente de um booking que já estava cancelado antes da chamada atual, sem repetir audit/outbox nem criar estados de cancelamento incompletos.

## Decisão

Introduzir a tool `cancel_booking` com capability `booking.cancel`, efeito `write` e input público estrito composto por:

- `bookingId` UUID;
- `reason` opcional, bounded;
- `confirmed: true` obrigatório;
- `additionalProperties: false`.

`tenantId`, `customerId`, `conversationId`, `turnId`, `expectedModeEpoch` e `idempotencyKey` são sempre injetados pelo `ToolExecutor` a partir do contexto confiável e nunca são aceites no schema público.

A implementação é live-only e executa a mutação numa única transação PostgreSQL:

1. aplica `app.tenant_id` para RLS;
2. verifica replay por `(tenant_id, idempotency_key)` e exige correspondência exata de booking, conversation, customer, turn, operação e hash dos argumentos;
3. bloqueia a conversation por `FOR UPDATE` e exige `AI_ACTIVE` com `mode_epoch` exatamente igual ao esperado;
4. bloqueia o booking por `FOR UPDATE` exigindo simultaneamente tenant, booking ID e customer owner;
5. devolve `not_found` quando o booking não está no customer scope, sem remover filtros de ownership;
6. se o booking já estiver cancelado, devolve sucesso sem repetir a mutação;
7. regista a operação idempotente, atualiza o booking para `cancelled` com `cancelled_at` obrigatório e razão opcional, incrementa a versão, cria outbox e audit dentro da mesma transação.

A migration adiciona `cancelled_at`, `cancellation_reason`, uma constraint que proíbe estados de cancelamento incompletos e a tabela tenant-scoped `booking_operations` com RLS e unique key de idempotência. A exclusion constraint existente continua a autoridade sobre overlap para bookings ativos; não é enfraquecida pelo cancelamento.

## Consequências

- O modelo nunca controla tenant/customer/conversation/turn/epoch nem a idempotency key.
- Um `bookingId` por si só não concede autoridade para cancelar.
- Customer ownership e tenant isolation são impostos tanto por RLS/contexto PostgreSQL como pelos predicados explícitos da query.
- Fencing obsoleto falha antes da mutação.
- Replay exato não repete audit, outbox ou mudança de estado; reuse conflitante da mesma idempotency key é rejeitado.
- O estado `cancelled` não pode existir sem `cancelled_at`.
- `cancel_booking` não altera as garantias já validadas de `create_booking` nem mistura lógica de remarcação.

## Validação

A cobertura unitária verifica schema público estrito, confirmação obrigatória, UUID e reason bounds, capability gating, rejeição de scope injetado e injeção server-owned do contexto de write.

A integração PostgreSQL real verifica fencing, customer ownership, atomicidade, replay idempotente e estado cancelado válido. Durante a validação foi também corrigido um fixture antigo de booking foundation que criava diretamente `status='cancelled'` sem `cancelled_at`; a constraint foi mantida intacta e o fixture passou a representar um estado válido.

O workflow #350 ficou integralmente verde no HEAD `93f35435989f7c28001cbaad5c80abaf4ae66f9b`, incluindo formatter, lint, TypeScript strict, 122 testes unitários, integração PostgreSQL com worker real, restart/recovery de Redis, OpenAPI, audit/connectivity, dependency audit, Flutter analyze/tests/web build e Docker Compose readiness.
