# Billing, entitlements e utilização

## Quarta fatia implementada — ADR-107 (schema 66)

A reconciliação manual já não usa `MIGRATION_DATABASE_URL`. O papel `melissa_billing_reconciler` é separado, `NOLOGIN` por defeito, sem herança, superuser ou bypass RLS. O comando usa `BILLING_RECONCILER_DATABASE_URL` e recusa ser executado com a conta administrativa. A migration 66 dá acesso à leitura dos eventos Stripe assinados, leitura de associações existentes e do ID do preço Stripe, UPDATE limitado a estados e períodos de faturação e INSERT/SELECT de auditoria. Não pode escrever no catálogo, associar uma nova empresa, modificar cliente/plano/preço, ler contas nem eliminar eventos/auditoria.

Para uma base PostgreSQL **de teste**, o operador provisiona a senha através de `infra/scripts/billing-reconciler-login.sql` com variável psql `reconciler_password`, sem a colocar no repositório. O papel mantém-se NOLOGIN no Compose normal. O CI ativa-o apenas com senha descartável, e usa-o para executar o reconciliador em PostgreSQL real; verifica permissões negadas. A ligação privilegiada permanece apenas para migrations e fixtures controladas de teste. Este papel ainda não autoriza deploy/worker automático, Checkout, cobranças ou direito a funcionalidades pagas. [ADR-107](decisions/ADR-107-stripe-dedicated-reconciler-role.md). **Validação:** [CI #38352760844](https://github.com/HernanyManuel/Melissa/actions/runs/38352760844) **integralmente verde** no commit `124d143052cf7042d5cbabf8e0c4007818cf1d24`: backend (formatação, lint, TypeScript, unitários, PostgreSQL/RLS com worker/Redis real, OpenAPI e auditoria), Flutter (análise, testes e build Web) e Compose (readiness). O CI detetou que o ORM inseria explicitamente `created_at` na auditoria, exigindo um grant demasiado amplo; foi corrigido para `INSERT` SQL parametrizado que deixa o timestamp ao PostgreSQL, conservando estritamente os grants de cinco colunas.

## Quarta fatia implementada — ADR-108 (Flutter, schema 66)

Existe agora `/billing/:tenantId` na aplicação Flutter, acessível no ecrã de conta aos papéis owner/admin. Utiliza somente os **dois endpoints GET da ADR-104**, sem criar recursos nem interagir com o Stripe. Mostra planos ativos, preços e cotas configuradas, além de snapshot de subscrição com datas e cancelamento. Não apresenta nomes de planos ausentes como subscrição ativa; informa que os serviços pagos permanecem desativados, mesmo com `status=active`, enquanto `billingVerified=false` e `automationEnabled=false`. Um contrato de permissões inesperadamente ativado é recusado pela interface, em vez de permitir fluxos novos.

O servidor continua a impor `billing:read`, independente da navegação UI. Os pedidos HTTP são apenas GET; dados antigos são ocultados ao mudar empresa, perder acesso ou receber erro, e respostas atrasadas não podem poluir outra empresa. Testes de widgets cobrem autorização/403, preço de catálogo, ausência de subscrição e apresentação cautelosa de estados ativos. Traduções pt/en/es/fr/it/de. [ADR-108](decisions/ADR-108-flutter-read-only-billing-page.md). O ecrã não implementa Checkout, Portal, invoices, visualização de consumos ou contratação real.

## Terceira fatia implementada — ADR-106 (schema 65)

`stripe-reconciler.ts` disponibiliza uma operação **manual de teste** sobre eventos Stripe assinados e já armazenados. A associação a empresa só é feita por `subscriptions.provider_subscription_id` **previamente registado** (nunca por metadata do webhook). Para cada associação conhecida, bloqueia a subscrição no PostgreSQL, consulta o estado atual do Stripe por API test restrita, verifica cliente, ID de subscrição e preço configurado, e só então atualiza status, período, cancelamento e trial. As modificações são transacionais e gravam uma tentativa em `stripe_reconciliation_attempts` (schema 65; RLS sem grants de runtime); eventos desconhecidos, período inválido, múltiplos itens, contas divergentes, API indisponível ou live mode **nunca** criam subscrições ou desbloqueiam direitos.

A API Stripe de 2025-03-31.basil transferiu `current_period_start` e `current_period_end` para os itens da subscrição. O reconciliador exige um único item no catálogo atual e não suporta billing de múltiplos preços. Confirmação: [Stripe changelog](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).

Comando apenas em ambiente de teste: `NODE_ENV=test STRIPE_TEST_RECONCILE_ENABLED=true STRIPE_TEST_SECRET_KEY=sk_test_... BILLING_RECONCILER_DATABASE_URL=... pnpm --filter @melissa/backend stripe:reconcile-test evt_...`. Nunca executar contra dados reais, nem inserir credenciais na linha de comandos partilhada ou em logs. É um comando de operador offline com credencial de papel de **permissões mínimas**, **não um worker produção**. O default continua desligado e não cria Checkout nem outorga `entitlements`. A API comercial existente permanece somente leitura e `billingVerified=false`. Antes de produção faltam onboarding Stripe verificado, mapping seguro de novas contas, quotas e leitura de provider real em sandbox com CLI/Stripe test account. [ADR-106](decisions/ADR-106-stripe-test-subscription-reconciliation.md). **CI funcional:** [run #38274571857](https://github.com/HernanyManuel/Melissa/actions/runs/38274571857), verde no commit `091f0cb78eb0986cddbf76335a4865c6f46eecdc`.

## Segunda fatia implementada — ADR-105 (schema 64)

A aplicação já dispõe de `POST /webhooks/stripe` (fora de `/api/v1`) com transporte **desativado por defeito**. Só se pode ativar num ambiente Stripe **test** controlado mediante `STRIPE_WEBHOOK_ENABLED=true` e `STRIPE_WEBHOOK_SECRET=whsec_...`. A configuração rejeita habilitação sem segredo; não configurar endpoint ativo em produção. O corpo JSON é lido como bytes originais (máximo 256 KiB; sem descompressão), verificado com `Stripe-Signature: t=...,v1=...` e janela ±300 segundos. Rejeita `livemode=true`, envelopes incorretos e colisões com o mesmo ID e corpo divergente. Assinaturas repetidas com conteúdo idêntico recebem ACK idempotente.

A nova tabela global `stripe_webhook_events` conserva os **seis eventos relevantes** suportados (§45), o JSONB integral (sensível), ID, hash SHA-256, tipo e timestamp provider, sempre com `status=received`. Tipos assinados desconhecidos são ignorados com ACK. `melissa_runtime` consegue inserir mas **não pode ler o payload**, alterar ou apagar eventos; a RLS é forçada, com políticas específicas, e não existe leitura pública. Eventos não se tornam uma subscrição nem autorizam acesso a funcionalidades premium. O reconciliador de eventos, a ligação a tenants por IDs de provider confirmados, a ordenação, outbox/worker, auditoria, retenção, Stripe test CLI/E2E e Checkout continuam pendentes. Documentado em [ADR-105](decisions/ADR-105-signed-stripe-test-webhook-inbox.md).

## Primeira fatia implementada — ADR-104 (schema 63)

As tabelas `plans` e `subscriptions` existem, mas sem seed de preços e **sem qualquer escrita HTTP ou Stripe**. A runtime role lê somente colunas públicas do catálogo e projeções da subscrição sob RLS; referências de cliente/subscrição/product/price do Stripe não são legíveis via API. Owner/admin podem consultar `GET /api/v1/tenants/:tenantId/billing/plans` e `GET /billing/subscription`. A ausência de subscrição devolve `subscription:null`. Mesmo uma snapshot de teste com `status=active` continua a devolver `automationEnabled:false` e `billingVerified:false`, enquanto não houver confirmação assinada, reconciliação e enforcement de quotas. O onboarding não foi desbloqueado.

Esta fundação não implementa ainda checkout, processamento/reconciliação de webhooks assinados, invoices, cobrança, quotas ou ativação. A **receção assinada e o event inbox sem processamento** foram acrescentados depois na ADR-105. Não confundir estados visíveis na DB com direito a serviço. Testes integrados [CI funcional #38244880710](https://github.com/HernanyManuel/Melissa/actions/runs/38244880710), verde no commit `9b1484bef1641741f4bd72a39151cb29c39ddc90`, e ADR [104](decisions/ADR-104-billing-catalog-subscription-read-only-foundation.md).

Stripe gere pagamentos/subscrições; PostgreSQL conserva estado local reconciliado e ledger de uso. Preços/limites configurados em plans e mapeados para Stripe; exemplos de §43 são seeds editáveis, não constantes no código.

## Estado e autorização

Checkout/Portal exigem billing.write. Redirect de sucesso não ativa tenant; confirmação vem de eventos verificados e consulta ao provider quando necessário. Webhook persiste evento + outbox, consumer idempotente atualiza estado. Eventos podem chegar fora de ordem; reconciliar subscrição atual no provider em vez de comparar apenas timestamp do evento.

Estados da subscrição mantêm vocabulário do provider; operational_status do tenant é separado. Past_due inicia grace period configurável; suspended bloqueia automação paga, mantendo acesso do owner a billing, export e recuperação conforme política. Payment failure nunca apaga dados. Cancel_at_period_end preserva acesso até data válida; downgrade e proration são explícitos na UI.

## Unidade comercial proposta (a confirmar antes de cobrar)

Conversation session faturável começa na primeira mensagem inbound elegível, após 24h de inatividade da sessão anterior; janela de sessão distinta da janela comercial de WhatsApp. Uma única chave ledger por sessão. Handoff não reinicia cobrança; spam/bloqueios/sandbox excluídos conforme política. Alterações desta definição exigem versão e comunicação. A thread da UI pode conter múltiplas sessões faturáveis; acrescentar `billable_conversation_sessions` na migration P9.

A especificação dá limites por conversa mas não define a unidade temporal. Esta escolha é provisória, não valor contratual publicado. Pricing de extras, impostos, trial/grace e proration também requerem decisão de produto antes do Checkout real.

## Ledger e concorrência

Usage events append-only com dedup key, referência, quantity/unit, moeda e versão de custo. Reservar quotas/budget atomicamente antes de iniciar trabalho; settle/release após resultado e reconciliar órfãos por TTL. Cache ajuda leitura mas não autoriza exceder limite. Redis perdido não elimina consumo. API valida feature/staff/channel/usage no backend.

Meter deliveries para Stripe têm idempotency keys estáveis, receipt e estado; replay de eventos não fatura duas vezes. Enviar quantidade validada na integração configurada e reconciliar com invoice/provider. Ajustes através de eventos compensatórios, não editar ledger. Usar decimals e converter para minor units com escala da moeda.

Warnings 80/90/100% uma vez por limiar/período/canal. CostGuard separa teto de custo interno de limites comerciais; controla custos por dia/mês e loops. Tarifas do provider configuráveis/versionadas; nunca concluir margem sem moeda/período compatíveis.

## Métricas

MRR normaliza valor recorrente mensal e exclui receitas pontuais/tributos; ARR=12×MRR; ARPU exige denominador e período definidos; churn define cohort e data de cancelamento efetivo. Não somar moedas sem taxa FX/version/data explícita. COGS estimado separado de custo conciliado. Preços de exemplo não representam receita real.

## Testes P9

Stripe test Checkout/Portal, trial/cancel/upgrade/downgrade, webhook repetido/fora de ordem, invoice.paid/payment_failed, grace recovery, quota concorrente, overages, retry de envio de meter, reconciliation e warnings. Versão Stripe API fixada na implementação após consulta à documentação oficial. Não marcar integração real concluída por testes de mock.
