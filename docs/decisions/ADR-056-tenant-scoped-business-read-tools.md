# ADR-056 — Tools de leitura de negócio com âmbito de tenant

## Estado

Aceite para o incremento atual da Phase 5.

## Decisão

As primeiras tools de domínio são exclusivamente de leitura: `get_business_info`, `get_services`, `get_service_details`, `get_price`, `get_business_hours` e `get_staff`. Cada uma possui schema fechado, validator semântico, capability própria e output mínimo orientado à resposta ao cliente.

Os handlers dependem de `BusinessToolReader`, não de Prisma. `PrismaBusinessToolReader` implementa essa porta com uma transação curta, define `app.tenant_id` localmente para RLS e inclui `tenantId` em cada filtro. O tenant é sempre retirado de `ToolExecutionContext`; não faz parte dos argumentos expostos ao LLM.

Serviços inativos ou arquivados não são apresentados. Dados privados de staff, configuração interna, campos legais/provisioning e metadata operacional são excluídos. Valores Decimal são serializados como strings para evitar perda de precisão. Horários exigem uma data local explícita e devolvem timezone, períodos e eventual exceção.

## Consequências e limites

- O mesmo catálogo serve todos os tenants sem duplicar tools.
- Uma tentativa de injetar `tenantId`, usar UUID inválido ou data impossível falha antes do reader.
- As tools ainda não estão ligadas ao worker/loop de conversação e, portanto, não são executáveis por tráfego real.
- Este incremento não inclui FAQs, políticas, disponibilidade, bookings ou qualquer escrita.
- A ativação futura terá de derivar capabilities de configuração, entitlement e estado do tenant, e adicionar testes PostgreSQL de isolamento ao caminho conversacional completo.
