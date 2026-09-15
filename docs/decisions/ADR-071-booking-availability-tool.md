# ADR-071 — Disponibilidade de reservas server-owned e timezone-aware

## Estado

Proposto.

## Contexto

A IA precisa consultar horários realmente reserváveis sem transformar a consulta de disponibilidade numa reserva implícita nem confiar em tenant, duração, buffers, timezone ou resource fornecidos pelo modelo.

ADR-004 já define o booking por resource obrigatório e a exclusão PostgreSQL como autoridade contra sobreposição. A camada de disponibilidade precisa respeitar essa fundação, horários/exceções locais do negócio e staff opcional sem duplicar a regra de integridade no ToolRegistry.

## Decisão

Introduzir `BookingEngine.availableSlots` como autoridade de domínio para disponibilidade e expô-lo pela tool read-only `get_available_slots`.

O input público da tool é limitado a:

- `serviceId` UUID obrigatório;
- `date` local no formato `YYYY-MM-DD` obrigatória;
- `staffId` UUID opcional.

Tenant é sempre derivado do contexto confiável do executor. A tool usa a capability `booking.availability.read`, não suporta idempotency de write e devolve explicitamente disponibilidade, não uma reserva.

Dentro do BookingEngine:

1. aplica `app.tenant_id` para RLS;
2. exige tenant existente e serviço ativo, não eliminado e com booking ativo;
3. sem staff, resolve/cria idempotentemente o resource default; com staff, exige `StaffService` e staff ativos e resolve/cria o resource staff;
4. usa duração customizada do staff quando configurada, senão a duração do serviço;
5. resolve horário normal ou exceção para a data local; exceção fechada devolve zero slots;
6. converte os limites locais para instantes com `AT TIME ZONE` na timezone do tenant dentro do PostgreSQL;
7. gera candidatos em grelha de 15 minutos;
8. remove candidatos cujo intervalo ocupado, incluindo buffers do serviço, intersecta bookings `pending` ou `confirmed` do resource;
9. limita a resposta a 50 slots.

Os bookings continuam protegidos independentemente desta leitura pela exclusão GiST de ADR-004 sobre os intervalos ocupados persistidos. Portanto um slot devolvido pode deixar de estar livre antes de uma futura criação; `get_available_slots` nunca constitui hold, lock ou confirmação.

## Consequências

- Conversão timezone/DST fica junto da consulta PostgreSQL e não depende de aritmética manual em JavaScript.
- Staff continua opcional para o caller, mas todo cálculo usa um resource obrigatório.
- Buffers afetam tanto a integridade DB como a visibilidade de disponibilidade.
- A tool não aceita tenant nem metadata de fencing vindos do modelo.
- A criação de booking continua fora deste ADR e terá de revalidar a seleção na transação de write, usando a exclusão PostgreSQL como autoridade final contra corridas.

## Validação

A cobertura inclui schema estrito/capability da tool e integração PostgreSQL real para resource default idempotente, staff resource, duração customizada, horário normal, exceção fechada, buffers, RLS, boundary `[)` e timezone `Europe/Lisbon`, incluindo a conversão de 09:00 local para 08:00Z em setembro. O workflow #300 validou formatter, lint, TypeScript strict, unitários, integração, recovery, OpenAPI, dependency audit, Compose e Flutter web build no HEAD funcional `8ad5b28820dfb933de844551f2d868218d6a090c`.
