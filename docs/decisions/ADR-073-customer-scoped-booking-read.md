# ADR-073 — Leitura de booking customer-scoped pela IA

## Estado

Proposto.

## Contexto

Depois de criar bookings de forma fenced e idempotente, a IA precisa consultar uma reserva concreta para responder sobre horário, serviço, staff, estado e snapshots comerciais. O identificador do booking pode surgir no contexto da conversa, mas não pode ser usado como autorização: tenant e customer continuam a ser scope server-owned.

Uma leitura por ID também não deve revelar se um booking válido pertence a outro customer. Distinguir “existe mas não tens acesso” de “não existe” criaria um oracle de enumeração desnecessário.

## Decisão

Introduzir a tool read-only `get_booking` com input público limitado a `bookingId` UUID.

`tenantId` e `customerId` são sempre injetados pelo executor a partir do contexto confiável. A tool usa capability independente `booking.read` e não suporta idempotência de write.

A implementação usa um reader Prisma dedicado que, dentro de uma transação read-only lógica:

1. aplica `app.tenant_id` para RLS;
2. consulta o booking exigindo simultaneamente `tenant_id`, `customer_id` e `booking_id`;
3. junta apenas dados server-owned de serviço, resource e staff necessários à resposta;
4. devolve datas UTC, timezone efetivo e snapshots de duração/preço/moeda quando disponíveis;
5. devolve `{ found: false }` tanto para ID inexistente como para booking fora do customer scope.

A resposta não expõe conversation/turn IDs, idempotency keys, argument hashes ou outros metadados internos de execução.

## Consequências

- Um `bookingId` nunca concede acesso por si só.
- RLS e predicado explícito por customer fornecem defesa em profundidade.
- A IA pode responder sobre uma reserva específica sem receber identificadores de tenant/customer no schema público.
- Cross-customer lookup e lookup inexistente têm o mesmo resultado observável.
- A operação permanece separada de cancelamento/remarcação, que exigem fencing e idempotência de write próprios.

## Validação

A cobertura unitária verifica schema mínimo, injeção de tenant/customer pelo executor, rejeição de scope injetado, UUID inválido e capability ausente. A integração PostgreSQL real cria dois customers no mesmo tenant e confirma que o booking é legível apenas pelo customer proprietário, enquanto outro customer e um ID inexistente recebem exatamente `{ found: false }`.

O workflow #331 ficou integralmente verde no HEAD `500433eec4f329b8231d317bcd090342219e2d9a`, incluindo 30 migrations, seed idempotente, formatter, lint, TypeScript strict, unitários, integração PostgreSQL, recovery, OpenAPI, dependency audit, Compose e Flutter web build.
