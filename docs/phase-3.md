# Phase 3 — Onboarding e configuração do negócio

Entrega no PR #4, empilhada sobre a Phase 2. Implementa perfil empresarial, templates de indústria seguros, serviços, horários com múltiplos períodos, exceções, colaboradores ligados a serviços, FAQs, políticas e personalidade. O Flutter oferece um wizard responsivo em seis idiomas e retoma dados persistidos.

## Dados e isolamento

Migration 20260902000300_business_onboarding. Todas as tabelas empresariais usam tenant_id, chaves primárias ou únicas tenant-first, RLS ENABLE/FORCE e role runtime sem bypass. staff_services possui FKs compostas (tenant_id, staff_id) e (tenant_id, service_id), impedindo ligações entre empresas mesmo se a autorização da aplicação tiver um defeito.

Preços são decimal(20,6) na DB e strings decimais na API; nunca float. Moeda ISO-4217. Durações e buffers têm limites explícitos. Timezone é IANA validada. Website aceita apenas HTTPS. Telefone aceita E.164. Remoção de serviço é soft delete e desativa o serviço.

Horários são substituídos atomicamente e rejeitam períodos sobrepostos no mesmo dia. A DB também valida weekday, formato HH:mm e ordem start/end. Exceções fechadas não admitem horas; exceções abertas exigem intervalo válido.

## API implementada

- GET /api/v1/industry-templates
- PUT /api/v1/tenants/:id/profile
- GET /api/v1/tenants/:id/onboarding
- CRUD inicial de /services
- GET/PUT /business-hours e POST /schedule-exceptions
- GET/POST /staff
- GET/POST /faqs
- GET/PUT /configuration

Leitura: owner, admin, manager, staff e viewer. Escrita: owner, admin e manager. O backend volta a validar sessão, membership e role dentro da transação. Todos os IDs de recurso são combinados com tenant_id; um ID de outra empresa não é encontrado.

O estado do onboarding informa passos concluídos e blockers. A ativação é deliberadamente allowed=false até channel, calendar, subscription e agent_tests existirem nas fases próprias. Não há ativação simulada.

## Wizard Flutter

O wizard divide a configuração em Empresa, Serviços, Horários, Equipa, FAQs e Políticas/estilo. Possui loading, erro recuperável, passos navegáveis, valores iniciais seguros e layout vertical em ecrãs estreitos. Colaboradores são opcionais. As seis línguas têm os mesmos campos.

O onboarding completo da especificação tem 12 passos. Integrações, plano, simulador real do agente e ativação pertencem às Phases 4–9 e aparecem como blockers, não como sucessos fictícios. Autosave existe por conclusão de cada passo; edição detalhada e remoção no Flutter serão expandidas antes do release, enquanto APIs já suportam atualização/soft-delete de serviços.

## Testes e operação

CI executa migration com owner, API com melissa_runtime, lint/typecheck/unit, integração real com PostgreSQL/Redis, Flutter analyze/test/build e Compose. A suite cobre website inseguro, perfil, preço decimal, horário sobreposto, exceção, FAQ, staff-service, FK cross-tenant, RLS sem contexto e status de ativação bloqueado.

Mailpit e credenciais externas permanecem conforme Phase 2. Nenhuma chave de provider foi criada. Production continua bloqueada.
