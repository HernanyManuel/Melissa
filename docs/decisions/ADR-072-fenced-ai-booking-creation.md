# ADR-072 — Criação de booking confirmada, fenced e idempotente pela IA

## Estado

Proposto.

## Contexto

Depois de `get_available_slots`, a IA precisa transformar uma escolha explicitamente confirmada pelo customer numa reserva durável sem confiar em tenant/customer/conversation/turn/epoch/idempotency vindos do modelo e sem assumir que um slot previamente observado continua livre.

ADR-004 mantém o PostgreSQL como autoridade de integridade através da exclusão GiST por resource e intervalo ocupado. ADR-071 torna disponibilidade uma leitura sem hold. A criação precisa portanto revalidar a seleção dentro da transação e aceitar que uma corrida possa tornar o slot indisponível entre leitura e write.

## Decisão

Introduzir `BookingEngine.createBooking` e expô-lo pela tool write `create_booking`.

O input público é limitado a:

- `serviceId` UUID obrigatório;
- `startsAt` RFC 3339 com offset explícito obrigatório;
- `staffId` UUID opcional;
- `confirmed: true` obrigatório.

Tenant, customer, conversation, turn, `mode_epoch`, execution mode e idempotency key são sempre injetados pelo executor. A tool usa capability `booking.create`, é live-only e suporta idempotência durável.

Dentro da mesma transação PostgreSQL, a criação:

1. aplica `app.tenant_id` para RLS;
2. bloqueia a conversation e exige ownership do customer, estado `AI_ACTIVE` e `mode_epoch` exato;
3. resolve serviço/resource/staff usando apenas configuração server-owned;
4. bloqueia o resource ativo;
5. converte o instante para a data local do tenant e exige que corresponda exatamente a um candidato real da grelha de 15 minutos no horário/exceção aplicável;
6. calcula `ends_at` a partir da duração efetiva e persiste buffers, timezone, duração, preço e moeda como snapshots;
7. insere `confirmed` com `ON CONFLICT DO NOTHING`; a exclusão GiST continua a autoridade final contra overlap;
8. distingue slot indisponível de replay idempotente usando `tenant_id + idempotency_key` e fingerprint dos argumentos;
9. em criação nova, grava `booking_outbox(created)` e audit `ai.booking_created` atomicamente.

Replay com a mesma key e mesmos argumentos devolve o mesmo booking com `duplicate: true` sem repetir outbox/audit. Reuso da key com scope ou argumentos diferentes falha com conflito de idempotência. Sandbox falha antes da mutação.

## Consequências

- Disponibilidade continua não reservante; a criação revalida antes do write.
- Uma corrida legítima devolve `unavailable` em vez de escolher silenciosamente outro horário ou staff.
- A exclusão PostgreSQL protege double-booking mesmo que a lógica de aplicação seja executada concorrentemente.
- O booking preserva snapshots necessários para leitura e futuras integrações sem depender de alterações posteriores ao serviço.
- Criação e evento de outbox/audit têm a mesma fronteira transacional.
- Cancelamento e remarcação continuam operações separadas e terão regras próprias de fencing/idempotência.

## Validação

A cobertura inclui boundary tests da tool para confirmação explícita, timestamp com offset, UUIDs, scope server-owned e capability; e integração PostgreSQL real para criação confirmada, snapshots, outbox/audit únicos, replay idempotente, conflito de payload, slot ocupado, instante off-grid, fence obsoleto e bloqueio de sandbox. O workflow #317 ficou integralmente verde no HEAD `24ae6c2f813856ef3c9ec187ea8a688ec254dc45`, incluindo 30 migrations, seed idempotente, formatter, lint, TypeScript strict, unitários, integração PostgreSQL, recovery, OpenAPI, dependency audit, Compose e Flutter web build.
