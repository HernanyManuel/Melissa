# Estado do projeto

## Phase 4 — Rascunho parcial: clientes

Branch `feature/phase-4-messaging`, baseada em `feature/phase-3-business-onboarding` no commit `1c5c2507bdfd350b0b4bf4a475a579786bbeda36`. Publicação em rascunho autorizada pelo utilizador; não pronta para merge ou produção.

Código inicial: modelo Customer, migration com RLS forçada, telefone único por tenant, listagem paginada, criação, atualização integral e arquivo lógico, permissões específicas e auditoria transacional. CORS passa a permitir PUT/DELETE para a origem configurada. A especificação original permanece intacta.

Validação inicial: backend e Compose do commit `f4a450b` passaram na execução GitHub Actions `33636792678`. A tentativa local anterior de gerar Prisma foi interrompida por autorização de rede cancelada; os checks remotos permitem executar migrations e a suite existente sem ambiente do utilizador.

A continuação adiciona regressões HTTP/PostgreSQL para clientes à suite de integração existente: autenticação, isolamento A/B, validação, duplicados concorrentes, telefone por tenant, RLS sem contexto, paginação, atualização integral, arquivo e auditoria. Acrescenta teste unitário da matriz de permissões. Execução destas novas regressões pendente da CI do novo commit; testes HTTP de cada papel e UI ainda pendentes. Não confundir testes escritos com testes aprovados.

Ainda não entregue nesta fase: interface Flutter de clientes, restantes campos do modelo especificado (incluindo consentimentos e preferências), canais, WhatsApp, conversas, mensagens, outbox, filas, debounce e media. Nenhum envio real, merge ou deploy efetuado. A Phase 4 permanece incompleta, mesmo que os checks existentes passem.

Contrato inicial: `/api/v1/tenants/:tenantId/customers` aceita GET (50 itens e cursor `after`) e POST; `/:id` aceita PUT e DELETE (arquivo lógico). Owner/admin/manager podem ler e escrever; staff apenas ler; viewer sem acesso. O telefone continua reservado após arquivo. PUT substitui os campos editáveis e limpa email/notas omitidos; não constitui PATCH parcial. Arquivo não é eliminação definitiva de dados pessoais.

## Phase 3 — Onboarding e configuração

Branch `feature/phase-2-identity`, PR #3, base empilhada sobre PR #2. Código de contas, verificação/reset, sessões revogáveis, tenants, memberships, convites, RBAC, auditoria e RLS implementado. Flutter Web ligado, com seis idiomas e consentimento de desenvolvimento.

CI do commit `357d681` aprovado: backend (migrations, lint, typecheck, quatro testes unitários e duas suites de integração com PostgreSQL/Redis), Flutter (análise, seis testes e build Web), Compose e auditoria sem vulnerabilidades conhecidas. [Execução verificada](https://github.com/HernanyManuel/Melissa/actions/runs/33579326319). A revisão final alinha nomes físicos da DB com snake_case; os checks do commit mais recente estão no PR #3. Sem merge nem deploy.

Phase 3 adiciona perfil, templates, serviços, horários/exceções, equipa, FAQs, políticas e personalidade com migration, RLS, APIs e wizard Flutter localizado. Branch `feature/phase-3-business-onboarding`, PR #4 sobre o PR #3. Validação final nos checks do PR; sem merge nem deploy.

Ver [entrega e limites da Phase 3](phase-3.md), [segurança de identidade](phase-2.md) e [plano](../IMPLEMENTATION_PLAN.md). P4 corresponde a clientes, canais, WhatsApp, conversas e mensagens.
