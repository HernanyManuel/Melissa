# ADR-034 — pnpm 11 e auditoria Bulk Advisory

Estado: migração de tooling; validação integral nos checks do PR.

As reexecuções do commit 618dc7f falharam com timeout no endpoint legado `/security/audits`, usando pnpm 10.11.0. A [documentação oficial do pnpm 11](https://pnpm.io/blog/releases/11.0) confirma que esse contrato foi retirado e substituído por `/security/advisories/bulk`. O timeout não prova sozinho a causa de rede; insistir no contrato retirado não é uma estratégia de recuperação.

Fixar pnpm 11.25.0 no packageManager, CI e Docker. Node 22.23.2 permanece. Migrar onlyBuiltDependencies para allowBuilds preservando a autorização de Prisma/esbuild; o postinstall não necessário do Nest permanece bloqueado explicitamente. Scripts de dependências desconhecidos não são autorizados automaticamente. CI confirma a versão efetiva para detetar fallback para pnpm 10.

Manter `pnpm install --frozen-lockfile` e `pnpm audit --audit-level high`, sem ignore-registry-errors, continue-on-error ou exceções de vulnerabilidades. Não alterar versões da aplicação apenas para migrar o package manager. Validar instalação limpa, Prisma, migrations, testes, OpenAPI, Docker e auditoria, além da regressão Flutter. Defaults de segurança v11 não são desligados.

Referências: [release 11.25](https://pnpm.io/blog/releases/11.25), [audit](https://pnpm.io/cli/audit). Os relatórios históricos de pnpm 10 permanecem como evidência do seu commit, não como configuração atual. Auditoria sem findings conhecidos não é certificação de segurança. Sem mudança de schema/produto, merge ou deploy.
