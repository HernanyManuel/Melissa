# Booking Engine

Invariantes §§28–33, 92, 116–117: o PostgreSQL decide reservas; disponibilidade consultada não é garantia de criação. Usar o mesmo serviço para UI, ferramentas de IA e rotinas internas.

## Cálculo

Entrada: TenantContext, customer quando aplicável, serviço, data/janela, timezone e preferência de staff. Backend resolve o resource elegível e duração/preço efetivos. Sem staff configurado usa recurso default de capacidade 1. Sem preferência de staff, escolher deterministicamente entre recursos elegíveis; revalidar antes de persistir.

Interseção de business hours e staff hours, exceções (fechado tem precedência), duração/buffers, antecedência/horizonte configurados, resource blocks, bookings pending/confirmed e busy externo válido. Intervalos `[start,end)` permitem adjacência sem sobreposição; buffers ampliam ocupação. Guardar timezone da reserva e apresentar offset. Horas locais inexistentes por DST são rejeitadas; horas ambíguas exigem offset explícito. “Amanhã” é interpretado no timezone do negócio, comunicado ao cliente.

A implementação atual usa uma primitive transacional comum para o calendário interno em `availableSlots`, `createBooking` e `reschedule_booking`. `staff_hours` é tenant-scoped com RLS. Quando não existe qualquer linha de horário individual para o funcionário naquele weekday, herda o horário do negócio; quando existe configuração individual, a disponibilidade é a interseção estrita dos períodos ativos. A presença de configuração com todas as linhas desativadas significa indisponibilidade, não fallback para business hours. Exceções de fecho continuam a ter precedência.

`resource_blocks` é tenant-scoped com RLS e intervalos `[start,end)`. Um candidate é bloqueado quando o seu intervalo ocupado — incluindo buffer anterior e posterior — intersecta um block. Availability filtra blocks como snapshot informativo; create/reschedule revalidam-nos dentro da transação depois de bloquear a linha de `booking_resources`. INSERT/UPDATE/DELETE de blocks usam trigger que adquire o mesmo resource lock, serializando alterações de blocks com writes de booking. Quando um UPDATE muda de resource, old/new são bloqueados em ordem estável. Um block criado depois de uma reserva não altera retroativamente essa reserva nem invalida exact replay de uma criação já comprometida.

## Criação atómica

1. Validar actor, customer/serviço/staff do tenant, plano, estado do tenant e chave de idempotência.
2. Obter informação externa antes da transação, com validade máxima e resultado explícito de staleness.
3. Iniciar transação curta; bloquear linha do resource e ordem estável de recursos se forem vários; revalidar horário/ocupação e versão da configuração.
4. Criar booking + snapshot de preço/duração + outbox + usage local/audit; constraint de exclusão decide conflitos finais.
5. Commit; iniciar sync externo e notificação por outbox. Resposta 201 confirma booking interno; estado de sync separado.

Updates de horário/bloqueios seguem a mesma disciplina de lock; mudanças que afetem reservas existentes devem exigir resolução explícita. Conflito devolve 409 SLOT_UNAVAILABLE com alternativas consultáveis; nenhum retry muda silenciosamente data/staff escolhido.

Exact replay de `create_booking` é resolvido a partir da reserva persistida antes de reavaliar epoch/calendário/blocks correntes. O replay valida conversation/customer/turn e arguments hash armazenados, devolve os snapshots persistidos e não repete efeitos. Assim uma alteração operacional posterior não transforma um commit anterior num falso `unavailable`.

## Cancelar/remarcar

Comprovada relação customer/conversation nas tools; ter UUID não autoriza operação. Version/If-Match evita lost updates. Reschedule e cancelamento são idempotentes; audit preserva ator/motivo. Mover entre recursos adquire locks em ordem estável. Falha na nova ocupação faz rollback da mudança inteira.

As tools de cancelamento/remarcação usam `expectedVersion` obtida por `get_booking`; essa versão é apenas uma precondition de concorrência e nunca uma autorização. Tenant/customer/conversation continuam server-owned.

Policies executáveis vivem em `booking_policies`, separadas do texto humano de `TenantConfiguration.cancellation/rescheduling`. A policy é tenant-scoped, RLS-protected e versionada, com `cancellation_enabled`, `rescheduling_enabled` e antecedência mínima independente para cada operação. Tenants sem configuração explícita recebem defaults determinísticos compatíveis (`enabled=true`, notice `0`) dentro da própria transação. Cancel/reschedule avaliam a policy com `CURRENT_TIMESTAMP` na mesma transação que bloqueia e altera a reserva; `policy_denied` não cria operation ledger, audit, outbox nem altera a reserva. Exact replay é resolvido antes da policy corrente, preservando exatamente o resultado já comprometido mesmo após uma alteração posterior da configuração. Texto livre nunca é interpretado como autorização.

## Calendário externo

Não é possível uma transação atómica comum entre PostgreSQL e edições independentes no Google. Garantimos ausência de sobreposição entre reservas internas. Para calendários externos: frescura controlada, revalidação, sync/reconciliação e aviso de conflito; não prometer ausência absoluta de corridas externas. Se disponibilidade externa obrigatória está indisponível/desatualizada, bloquear confirmação com erro claro; agenda puramente interna continua operacional.

Pending ocupa enquanto válido; se usado como hold deve ter expires_at, TTL configurado e job de libertação. Não criar holds infinitos. Pagamento de bookings não integra MVP.

## Testes de saída

Requests concorrentes no mesmo resource/slot → uma reserva. Slots adjacentes; buffers; default resource; tenant A/B; cancel+create; reschedule com falha preserva anterior; DST Europe/Lisbon/America/New_York; múltiplos intervalos; exceções; staff custom duration/price; calendar stale/revogado; mesma idempotency key retorna a mesma reserva, payload diferente conflita.

Cobertura PostgreSQL incremental inclui herança de business hours sem configuração individual, interseção de `staff_hours`, rejeição de criação/remarcação fora do horário individual, RLS de `staff_hours`, policy disable/minimum-notice sem side effects, replay depois de mudança de policy e RLS de `booking_policies`. `resource_blocks` cobre filtro com buffers, create/reschedule bloqueados, RLS tenant A/B, serialização por resource lock/trigger e exact replay de create após block posterior e epoch corrente diferente. A fronteira LLM/tool também preserva `policy_denied` como resultado funcional estruturado. Ainda faltam antecedência/horizonte para criação/disponibilidade, resource moves com lock order estável e calendários externos.
