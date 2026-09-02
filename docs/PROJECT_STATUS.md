# Estado do projeto

## Phase 3 — Onboarding e configuração

Branch `feature/phase-2-identity`, PR #3, base empilhada sobre PR #2. Código de contas, verificação/reset, sessões revogáveis, tenants, memberships, convites, RBAC, auditoria e RLS implementado. Flutter Web ligado, com seis idiomas e consentimento de desenvolvimento.

CI do commit `357d681` aprovado: backend (migrations, lint, typecheck, quatro testes unitários e duas suites de integração com PostgreSQL/Redis), Flutter (análise, seis testes e build Web), Compose e auditoria sem vulnerabilidades conhecidas. [Execução verificada](https://github.com/HernanyManuel/Melissa/actions/runs/33579326319). A revisão final alinha nomes físicos da DB com snake_case; os checks do commit mais recente estão no PR #3. Sem merge nem deploy.

Phase 3 adiciona perfil, templates, serviços, horários/exceções, equipa, FAQs, políticas e personalidade com migration, RLS, APIs e wizard Flutter localizado. Branch `feature/phase-3-business-onboarding`, PR #4 sobre o PR #3. Validação final nos checks do PR; sem merge nem deploy.

Ver [entrega e limites da Phase 3](phase-3.md), [segurança de identidade](phase-2.md) e [plano](../IMPLEMENTATION_PLAN.md). P4 corresponde a clientes, canais, WhatsApp, conversas e mensagens.
