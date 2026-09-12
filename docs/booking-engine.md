# Booking Engine

Invariantes §§28–33, 92, 116–117: o PostgreSQL decide reservas; disponibilidade consultada não é garantia de criação. Usar o mesmo serviço para UI, ferramentas de IA e rotinas internas.

## Cálculo

Entrada: TenantContext, customer quando aplicável, serviço, data/janela, timezone e preferência de staff. Backend resolve o resource elegível e duração/preço efetivos. Sem staff configurado usa recurso default de capacidade 1. Sem preferência de staff, escolher deterministicamente entre recursos elegíveis; revalidar antes de persistir.

Interseção de business hours e staff hours, exceções (fechado tem precedência), duração/buffers, antecedência/horizonte configurados, resource blocks, bookings pending/confirmed e busy externo válido. Intervalos `[start,end)` permitem adjacência sem sobreposição; buffers ampliam ocupação. Guardar timezone da reserva e apresentar offset. Horas locais inexistentes por DST são rejeitadas; horas ambíguas exigem offset explícito. “Amanhã” é interpretado no timezone do negócio, comunicado ao cliente.

A implementação atual usa uma primitive transacional comum para o calendário interno em `availableSlots`, `createBooking` e `reschedule_booking`. `staff_hours` é tenant-scoped com RLS. Quando não existe qualquer linha de horário individual para o funcionário naquele weekday, herda o horário do negócio; quando existe configuração individual, a disponibilidade é a interseção estrita dos períodos ativos. A presença de configuração com todas as linhas desativadas significa indisponibilidade, não fallback para business hours. Exceções de fecho continuam a ter precedência.

`resource_blocks` é tenant-scoped com RLS e intervalos `[start,end)`. Um candidate é bloqueado quando o seu intervalo ocupado — incluindo buffer anterior e posterior — intersecta um block. Availability filtra blocks como snapshot informativo; create/reschedule revalidam-nos dentro da transação depois de bloquear a linha de `booking_resources`. INSERT/UPDATE/DELETE de blocks usam trigger que adquire o mesmo resource lock, serializando alterações de blocks com writes de booking. Quando um UPDATE muda de resource, old/new são bloqueados em ordem estável. Um block criado depois de uma reserva não altera retroativamente essa reserva nem invalida exact replay de uma criação já comprometida.

A janela estruturada de criação vive em `booking_policies`: `creation_min_notice_minutes` e `creation_max_horizon_days` opcional. Notice `0` e horizonte `NULL` preservam o comportamento compatível. `availableSlots` continua read-only: lê a policy sem materializar defaults e filtra candidates usando limites derivados de `CURRENT_TIMESTAMP` do PostgreSQL. `createBooking` revalida a mesma janela dentro da sua transação; violações devolvem `policy_denied` com `minimum_notice` ou `maximum_horizon`, sem criar booking/outbox/audit. Exact replay é resolvido antes da policy corrente.

## Criação atómica

1. Validar actor, customer/serviço/staff do tenant, plano, estado do tenant e chave de idempotência.
2. Obter informação externa antes da transação, com validade máxima e resultado explícito de staleness.
3. Iniciar transação curta; bloquear linha do resource e ordem estável de recursos se forem vários; revalidar policy, horário, blocks, ocupação e versão da configuração.
4. Criar booking + snapshot de preço/duração + outbox + usage local/audit; constraint de exclusão decide conflitos finais.
5. Commit; iniciar sync externo e notificação por outbox. Resposta 201 confirma booking interno; estado de sync separado.

Updates de horário/bloqueios seguem a mesma disciplina de lock; mudanças que afetem reservas existentes devem exigir resolução explícita. Conflito devolve 409 SLOT_UNAVAILABLE com alternativas consultáveis; nenhum retry muda silenciosamente data/staff escolhido.

Exact replay de `create_booking` é resolvido a partir da reserva persistida antes de reavaliar epoch/calendário/blocks/policy correntes. O replay valida conversation/customer/turn e arguments hash armazenados, devolve os snapshots persistidos e não repete efeitos. Assim uma alteração operacional posterior não transforma um commit anterior num falso `unavailable`.

## Cancelar/remarcar

Comprovada relação customer/conversation nas tools; ter UUID não autoriza operação. Version/If-Match evita lost updates. Reschedule e cancelamento são idempotentes; audit preserva ator/motivo. Mover entre recursos adquire locks em ordem estável. Falha na nova ocupação faz rollback da mudança inteira.

As tools de cancelamento/remarcação usam `expectedVersion` obtida por `get_booking`; essa versão é apenas uma precondition de concorrência e nunca uma autorização. Tenant/customer/conversation continuam server-owned.

Policies executáveis vivem em `booking_policies`, separadas do texto humano de `TenantConfiguration.cancellation/rescheduling`. A policy é tenant-scoped, RLS-protected e versionada, com `cancellation_enabled`, `rescheduling_enabled` e antecedência mínima independente para cada operação. Tenants sem configuração explícita recebem defaults determinísticos compatíveis (`enabled=true`, notice `0`) dentro da própria transação. Cancel/reschedule avaliam a policy com `CURRENT_TIMESTAMP` na mesma transação que bloqueia e altera a reserva; `policy_denied` não cria operation ledger, audit, outbox nem altera a reserva. Exact replay é resolvido antes da policy corrente, preservando exatamente o resultado já comprometido mesmo após uma alteração posterior da configuração. Texto livre nunca é interpretado como autorização.

## Administração tenant-facing

A configuração estruturada de booking é exposta por endpoints autenticados tenant-scoped sob o mesmo `AuthGuard`, `TenantService.scoped` e permissões `business:read/write` das restantes configurações do negócio.

O GET/PUT de booking policy devolve `version`; o PUT exige `expectedVersion`. A linha é bloqueada e a versão é comparada dentro da mesma transação, impedindo lost updates entre administradores. Uma policy ainda não materializada é apresentada como defaults na versão lógica `1`; a primeira gravação válida avança para `2`. Versão stale devolve conflito e não altera policy nem cria audit.

A API de resource blocks mantém `booking_resources.id` server-owned. O cliente fornece `staffId` opcional; ausência significa o recurso default. Create/update resolve o resource dentro do tenant, adquire resource locks antes de verificar bookings e rejeita qualquer block que intersecte uma booking pending/confirmed, incluindo buffers. Mudança de staff/resource bloqueia old/new em ordem estável. Create/update/delete são auditados; RLS continua a defesa em profundidade.

## Calendário externo

Não é possível uma transação atómica comum entre PostgreSQL e edições independentes no Google. Garantimos ausência de sobreposição entre reservas internas. Para calendários externos: frescura controlada, revalidação, sync/reconciliação e aviso de conflito; não prometer ausência absoluta de corridas externas. Se disponibilidade externa obrigatória está indisponível/desatualizada, bloquear confirmação com erro claro; agenda puramente interna continua operacional.

Pending ocupa enquanto válido; se usado como hold deve ter expires_at, TTL configurado e job de libertação. Não criar holds infinitos. Pagamento de bookings não integra MVP.

## Testes de saída

Requests concorrentes no mesmo resource/slot → uma reserva. Slots adjacentes; buffers; default resource; tenant A/B; cancel+create; reschedule com falha preserva anterior; DST Europe/Lisbon/America/New_York; múltiplos intervalos; exceções; staff custom duration/price; calendar stale/revogado; mesma idempotency key retorna a mesma reserva, payload diferente conflita.

Cobertura PostgreSQL incremental inclui herança de business hours sem configuração individual, interseção de `staff_hours`, rejeição de criação/remarcação fora do horário individual, RLS de `staff_hours`, policy disable/minimum-notice sem side effects, replay depois de mudança de policy e RLS de `booking_policies`. `resource_blocks` cobre filtro com buffers, create/reschedule bloqueados, RLS tenant A/B, serialização por resource lock/trigger e exact replay de create após block posterior e epoch corrente diferente. A janela de criação cobre filtro read-only em availability, minimum notice, maximum horizon, criação permitida e exact replay após policy posterior mais restritiva. A superfície administrativa cobre owner/viewer permissions, tenant isolation, audit, policy optimistic versioning, default/staff blocks, stable resource move e rejeição de block sobre booking/buffer. A fronteira LLM/tool preserva `policy_denied` como resultado funcional estruturado.

Dentro do escopo interno P6 atual, o hardening de calendário/policy/blocks e a respetiva superfície administrativa estão completos. Resource moves no próprio `reschedule_booking` só serão necessários quando a operação passar a suportar efetivamente mudar staff/resource. Calendários externos, frescura e reconciliação permanecem P7.
