# ADR-075 — Remarcação de booking confirmada, versionada, fenced e idempotente pela IA

## Estado

Aceite no âmbito do PR #6 após validação funcional no workflow #384.

## Contexto

A especificação inclui `reschedule_booking` entre as tools iniciais da IA e exige que cancelamento/remarcação sejam atómicos, idempotentes e protegidos contra concorrência. `docs/booking-engine.md` acrescenta ownership customer/conversation, validação server-side, `Version/If-Match` contra lost updates, rollback integral quando a nova ocupação falha e PostgreSQL como autoridade final para conflitos internos.

Uma reserva pode mudar entre a leitura que fundamenta a conversa e a execução de uma mutação. O `mode_epoch` protege a autoridade da conversa, mas não substitui um precondition sobre o estado da própria reserva. Além disso, a idempotência de uma remarcação antiga deve permanecer reproduzível mesmo depois de remarcações posteriores.

## Decisão

`get_booking` continua a aceitar publicamente apenas `bookingId`, com tenant e customer injetados pelo backend, mas passa a devolver a `version` atual da reserva. Uma reserva inexistente e uma reserva de outro customer continuam indistinguíveis: `{ found: false }`.

`cancel_booking` e `reschedule_booking` exigem `expectedVersion` como precondition público. Este valor não concede acesso: tenant, customer, conversation, turn, epoch e idempotency key continuam exclusivamente server-owned. Ownership é sempre verificado por tenant + customer + booking e RLS continua ativa.

`reschedule_booking` aceita apenas `bookingId`, `expectedVersion`, `startsAt` com offset explícito e `confirmed: true`. A operação mantém o mesmo booking, serviço, recurso, duração e buffers; não oferece ao modelo uma mudança implícita de serviço ou funcionário durante uma remarcação.

A execução live:

1. verifica replay durável por `booking_operations` antes do estado corrente;
2. valida que a conversation pertence ao customer, permanece `AI_ACTIVE` e está no `mode_epoch` esperado;
3. bloqueia a reserva customer-scoped e rejeita versão diferente com `stale`;
4. bloqueia o recurso da reserva;
5. valida o novo instante contra timezone, horário/exceção aplicável e grelha suportada;
6. atualiza `starts_at`/`ends_at` apenas com `WHERE version = expectedVersion`, incrementando `version`;
7. deixa a exclusion constraint GiST decidir o conflito final de ocupação;
8. persiste operation ledger, outbox `rescheduled` e audit na mesma transação;
9. faz rollback integral se a nova ocupação conflitar.

Cada operação `reschedule` guarda `result_starts_at`, `result_ends_at` e `result_timezone` no ledger. Assim, replay exato de uma key antiga devolve o resultado original mesmo se o booking já tiver sido remarcado novamente. Reutilizar a mesma key com payload diferente é conflito de idempotência.

A outbox mantém `created` e `cancelled` como eventos singleton por booking, mas permite múltiplos eventos `rescheduled`. A idempotência da mutação continua no ledger de operações. O insert de `cancelled` usa `ON CONFLICT DO NOTHING`, compatível com o índice parcial singleton introduzido pela migration de remarcação.

Sandbox falha antes de qualquer write live. Foreign booking devolve `not_found`; overlap ou estado não remarcável devolve `unavailable`; precondition desatualizado devolve `stale` e obriga a nova leitura antes de nova confirmação.

## Limites deliberados

Esta decisão não declara o Booking Engine P6 completo. A modelação atual ainda não possui `staff_hours` integrados no cálculo e as políticas `cancellation`/`rescheduling` de `TenantConfiguration` são texto livre. Texto natural não é interpretado como autorização executável. Policies de booking precisam de representação estruturada, validada server-side, antes de serem consideradas enforceable.

A implementação atual também preserva o recurso existente em vez de mover automaticamente entre recursos. Uma futura remarcação entre recursos deve adquirir locks em ordem estável e reutilizar uma primitive transacional comum do Booking Engine.

Integração com calendários externos e respetiva frescura/reconciliação pertencem à fase de calendário e não são prometidas por esta decisão.

## Consequências

- leituras customer-scoped fornecem um token de versão útil sem ampliar autoridade;
- cancelamento e remarcação passam a partilhar a mesma proteção contra lost updates;
- replay idempotente é durável e independente do estado atual da reserva;
- múltiplas remarcações legítimas podem produzir eventos distintos de outbox;
- o modelo tem um contrato pequeno e explícito, enquanto scope e autoridade continuam no servidor;
- gaps de P6 permanecem visíveis em vez de serem mascarados por uma CI verde da tool.

## Evidência

Workflow #384 no commit funcional `4c332afa21f5deb2e5eabdbd0104c261b1e3c4d8` passou integralmente backend, Compose e Flutter, incluindo Prettier, lint, TypeScript strict, 124 testes unitários, integração PostgreSQL com worker real, restart/recovery Redis, OpenAPI, auditorias e build Flutter Web.

A integração cobre ownership, fencing da conversa, `expectedVersion`, replay exato, conflito de idempotência, overlap com rollback, segunda remarcação legítima, replay de uma remarcação antiga após uma posterior, múltiplos eventos `rescheduled` e sandbox live-only.