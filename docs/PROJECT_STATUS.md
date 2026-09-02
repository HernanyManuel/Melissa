# Estado do projeto

## Entrega atual

Phase 0 — arquitetura e plano preparados para revisão. Base: `c2324fe76dd5d8ec6a426403068fd8b50e2f0a3d`. Branch: `feature/phase-0-architecture`.

Entregue: plano de fases/gates, matriz 0–135, arquitetura/módulos, ERD lógico, regras de tenant e segurança, UX Flutter, API inicial parcial, motores IA/booking, integrações, billing, testes/deploy e oito ADRs. `SPECIFICATION.md` e `REPOSITORY_STRUCTURE.md` preservados integralmente.

## Verificação e limites

Verificações estruturais dos documentos e OpenAPI registadas em `docs/validation.md`. Não há backend, frontend executável, schema Prisma físico, migrations, testes de runtime ou pipeline CI nesta fase. Nada foi publicado em produção. Os ADRs são propostas para revisão, não decisões já aprovadas pelo utilizador.

## Próxima sessão: P1 — primeira infraestrutura executável

1. Ler SPECIFICATION, plano, arquitetura e ADRs; verificar estado real da branch/PR antes de alterar.
2. Fixar versões compatíveis após verificar documentação e ambiente disponível; criar monorepo sem placeholders.
3. Implementar NestJS API/worker, PostgreSQL/Redis compose, config validada, health/logging/erros, OpenAPI gerado e CI.
4. Implementar Flutter shell acessível com localization e estados assíncronos reais.
5. Executar build/lint/typecheck/test pertinentes; registar limitações de SDK/ambiente sem inventar sucesso.
6. Atualizar README com comandos comprovados e este estado; abrir PR de infraestrutura. P2 fecha primeira milestone com auth/tenants/RBAC e isolamento.

Bloqueios atuais: nenhum para iniciar infraestrutura local. Credenciais externas e escolhas comerciais só bloqueiam os gates próprios descritos em integrações/riscos. Não solicitar segredos pelo chat. Não continuar para live por bypass de pagamento/testes/validação.
