# Estado do projeto

## Phase 2 — Identidade e empresas

Branch `feature/phase-2-identity`, PR #3, base empilhada sobre PR #2. Código de contas, verificação/reset, sessões revogáveis, tenants, memberships, convites, RBAC, auditoria e RLS implementado. Flutter Web ligado, com seis idiomas e consentimento de desenvolvimento.

Lint, typecheck e testes unitários passam localmente. Flutter e Compose passaram na primeira execução do PR. CI backend inicialmente bloqueado por parâmetro de URL exclusivo do Prisma passado ao psql; corrigido antes de executar testes de isolamento. Estado final nos checks do PR #3. Sem merge nem deploy.

Ver [entrega e limitações](phase-2.md), [ADR-009](decisions/ADR-009-identity-runtime.md) e [plano](../IMPLEMENTATION_PLAN.md). P3 corresponde ao onboarding e configuração do negócio, depois dos gates da fase atual.
