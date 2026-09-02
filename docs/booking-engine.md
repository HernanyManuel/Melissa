# Booking Engine

Invariantes §§28–33, 92, 116–117: o PostgreSQL decide reservas; disponibilidade consultada não é garantia de criação. Usar o mesmo serviço para UI, ferramentas de IA e rotinas internas.

## Cálculo

Entrada: TenantContext, customer quando aplicável, serviço, data/janela, timezone e preferência de staff. Backend resolve o resource elegível e duração/preço efetivos. Sem staff configurado usa recurso default de capacidade 1. Sem preferência de staff, escolher deterministicamente entre recursos elegíveis; revalidar antes de persistir.

Interseção de business hours e staff hours, exceções (fechado tem precedência), duração/buffers, antecedência/horizonte configurados, resource blocks, bookings pending/confirmed e busy externo válido. Intervalos `[start,end)` permitem adjacência sem sobreposição; buffers ampliam ocupação. Guardar timezone da reserva e apresentar offset. Horas locais inexistentes por DST são rejeitadas; horas ambíguas exigem offset explícito. “Amanhã” é interpretado no timezone do negócio, comunicado ao cliente.

## Criação atómica

1. Validar actor, customer/serviço/staff do tenant, plano, estado do tenant e chave de idempotência.
2. Obter informação externa antes da transação, com validade máxima e resultado explícito de staleness.
3. Iniciar transação curta; bloquear linha do resource e ordem estável de recursos se forem vários; revalidar horário/ocupação e versão da configuração.
4. Criar booking + snapshot de preço/duração + outbox + usage local/audit; constraint de exclusão decide conflitos finais.
5. Commit; iniciar sync externo e notificação por outbox. Resposta 201 confirma booking interno; estado de sync separado.

Updates de horário/bloqueios seguem a mesma disciplina de lock; mudanças que afetem reservas existentes devem exigir resolução explícita. Conflito devolve 409 SLOT_UNAVAILABLE com alternativas consultáveis; nenhum retry muda silenciosamente data/staff escolhido.

## Cancelar/remarcar

Comprovada relação customer/conversation nas tools; ter UUID não autoriza operação. Policies validadas pelo backend. Version/If-Match evita lost updates. Reschedule e cancelamento são idempotentes; audit preserva ator/motivo. Mover entre recursos adquire locks em ordem estável. Falha na nova ocupação faz rollback da mudança inteira.

## Calendário externo

Não é possível uma transação atómica comum entre PostgreSQL e edições independentes no Google. Garantimos ausência de sobreposição entre reservas internas. Para calendários externos: frescura controlada, revalidação, sync/reconciliação e aviso de conflito; não prometer ausência absoluta de corridas externas. Se disponibilidade externa obrigatória está indisponível/desatualizada, bloquear confirmação com erro claro; agenda puramente interna continua operacional.

Pending ocupa enquanto válido; se usado como hold deve ter expires_at, TTL configurado e job de libertação. Não criar holds infinitos. Pagamento de bookings não integra MVP.

## Testes de saída

Requests concorrentes no mesmo resource/slot → uma reserva. Slots adjacentes; buffers; default resource; tenant A/B; cancel+create; reschedule com falha preserva anterior; DST Europe/Lisbon/America/New_York; múltiplos intervalos; exceções; staff custom duration/price; calendar stale/revogado; mesma idempotency key retorna a mesma reserva, payload diferente conflita.
