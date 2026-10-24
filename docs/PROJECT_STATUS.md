## Phase 10 — início do desenho de analytics (sem endpoint novo)

Branch `feature/phase-10-analytics` criada a partir da branch do PR #7 (ainda draft), sem merge/deploy. [Plano de entrada P10](phase-10-analytics.md): contrato preliminar read-only tenant-scoped e critérios de segurança para métricas técnicas, custos e operações. **Esta alteração é apenas documentação; não implementa métricas nem confirma receita.** A validação Stripe TEST E2E real da ADR-121 continua pendente; todos os bloqueios financeiros se mantêm.

## Phase 9 — ADR-121: observação de payout automático Stripe TEST (schema 79, CI aprovado)

Parser restritivo, leitor GET paginado, verificador offline segregado e CLI manual opt-in `stripe:payout-test in_... po_...`. Regista snapshots e auditoria imutáveis, com FORCE RLS, unicidade e serialização concorrente por invoice. O CI #39075192879 (HEAD `9335048`) passou backend, Flutter e Compose, incluindo integração PostgreSQL com Stripe simulado. **Falta E2E externo Stripe TEST real** e não existe prova de liquidação bancária; `payout_verified`, `settlement_verified`, `financial_clearance` e `billable` mantêm-se FALSE por CHECK SQL. PR #7 draft; sem merge, deploy, LIVE ou ativação de direitos pagos. [ADR-121](decisions/ADR-121-stripe-test-payout-reconciliation-foundation.md).

## Phase 9 — ADR-120: impactos de saldo Stripe TEST de grupos de Charges (schema 78)

A CLI offline `stripe:group-balance-test in_...` verifica a cadeia de 2–8 pagamentos/Charges de um grupo TEST previamente observado com riscos ADR-119 e consulta cada `balance_transaction` diretamente na Stripe. Grava snapshots append-only do bruto, fees/net e estados `pending/available`, com RLS, unicidade por hash, auditoria e papel verificador NOLOGIN-by-default. Mesmo disponibilidade integral de saldo **não prova payout bancário**: `payout_verified=false`, `settlement_verified=false`, `financial_clearance=false`, `billable=false` obrigatórios na base. Não altera o backend comercial, Flutter, entitlements, quotas ou cobranças; E2E Stripe sandbox real por realizar. [ADR-120](decisions/ADR-120-stripe-test-group-balance-impact-observations.md).

## Phase 9 — ADR-119: risco Stripe TEST de todas as Charges do grupo (schema 77)

A CLI manual `stripe:group-risk-test in_...` e a migration 77 verificam cada uma das Charges de um grupo de 2–8 InvoicePayments já registado (ADR-118). Conferem PI/Charge/customer/subscrição/preço, refusam listas parciais de refunds/disputes e registam snapshots imutáveis/replays com SHA-256 e auditoria no PostgreSQL, sob papel NOLOGIN de verificador. `refund_graph_verified=false`, `settlement_verified=false`, `financial_clearance=false`, `billable=false` são CHECKs obrigatórios; zero riscos observados não garante ausência de riscos futuros. Controles RLS e testes com fornecedor simulado, CI a confirmar no HEAD. Sem Stripe TEST E2E real, merge, deploy ou entitlements pagos. [ADR-119](decisions/ADR-119-stripe-test-multi-charge-risk-observations.md).

## Phase 9 — ADR-118: paginação limitada e pagamentos múltiplos Stripe TEST (schema 76)

As listas Stripe TEST de invoice payments, refunds, disputes e credit notes passaram a suportar cursores `starting_after` sob teto de 3 páginas e 100 objetos; cursores malformados/duplicados são rejeitados e qualquer lista acima do teto fica `has_more=true` para `deferred` em vez de ausência fictícia de risco. Uma nova CLI manual `stripe:payment-group-test in_...` observa grupos de 2–8 InvoicePayments ligados a PI/Charge exclusivos, validados contra invoice/tenant/subscrição/Checkout e soma original. A migration 76 cria ledger append-only com FORCE RLS e grants apenas para verificador offline. `refund_graph_verified=false`, `settlement_verified=false`, `financial_clearance=false` e `billable=false` continuam obrigatórios; não há verificação conjunta de refunds multi-Charge, cobrança, quotas pagas ou Stripe sandbox E2E. [ADR-118](decisions/ADR-118-bounded-stripe-test-pagination-and-payment-groups.md).

## Phase 9 — ADR-117: reembolsos e disputas Stripe TEST observados (schema 75)

Uma CLI manual `stripe:payment-risk-test in_...` pode, com conta/verificador dedicado em modo TEST, seguir a cadeia invoice evidenciada → InvoicePayment → PaymentIntent → Charge → refunds/disputes Stripe. Guardam-se snapshots append-only deduplicados por digest e tentativas auditadas, com RLS e sem grants API. Paginação incompleta é `deferred` e metadata não constitui identidade confiável. `settlement_verified`, `refunds_final`, `financial_clearance` e `billable` são obrigatoriamente false por CHECK PostgreSQL; não há política de receitas líquidas, reembolsos definitivos, invoice payouts nem entitlements pagos. Testes Stripe são simulados; E2E sandbox real pendente. Sem merge ou deploy. [ADR-117](decisions/ADR-117-stripe-test-refund-dispute-risk-observations.md).

## Phase 9 — ADR-116: revisão imutável de período e créditos Stripe TEST (schema 74)

A migration 74 adiciona `stripe_test_invoice_reviews` e `stripe_invoice_review_attempts` imutáveis, exclusivos do papel NOLOGIN de invoice verifier, sem grants API. A CLI manual `stripe:review-invoice-test in_...`, opt-in em `NODE_ENV=test`, valida invoice/subscription/preço no Stripe TEST, extrai o período da linha `subscription_item_details`, consulta credit notes paginadas e grava snapshots deduplicados por hash (novas notas originam novas observações). Tanto `refunds_verified` quanto `financial_clearance` e `billable` são necessariamente **false** por CHECK SQL. Não calcula liquidação, impostos, balance, quota comercial, nem reembolso concluído. Stripe sandbox real por verificar; CI final confirmar no HEAD. Não altera a trava global de entitlements, e não houve merge/deploy. [ADR-116](decisions/ADR-116-stripe-test-invoice-period-credit-review.md).

## Phase 9 — ADR-115: conversas candidatas e evidência invoice Stripe TEST (schema 73)

O uso técnico dos últimos 30 dias inclui agora `conversationCandidate`: conversas distintas com turn de IA concluído, `commercialPolicy=draft_only` e `billable=false`. Não é uma unidade contratual aprovada. A migration 73 cria evidência Stripe TEST de `invoice.paid` consultada diretamente no provider, vinculada à subscription/Checkout previamente associada, com auditoria append-only e RLS. A CLI offline `stripe:invoice-evidence-test` usa papel dedicado NOLOGIN de teste, sem acesso de mutação a tenants, subscrições ou entitlements. Os testes usam provider simulado em PostgreSQL real. **Uma fatura com estado paid não comprova liquidação definitiva nem concede direitos pagos.** `billingVerified=false`, `automationEnabled=false`; Stripe sandbox E2E continua pendente. [ADR-115](decisions/ADR-115-candidate-conversations-and-test-invoice-evidence.md).

## Phase 9 — ADR-114: ledger não faturável de uso técnico IA (schema 72)

O source `ai_usage_events` já grava um evento por execução de IA; a migration 72 cria `billing_usage_observations`, espelho append-only gerado transacionalmente por trigger, com FK ao source, unicidade tenant+turn, RLS forçada e **nenhuma permissão de escrita da API**. `billable=false` é garantido por CHECK. O novo `GET /api/v1/tenants/:tenantId/billing/usage`, owner/admin, apresenta apenas totais por resultado e tokens dos últimos 30 dias (strings inteiras exatas), `financialStatus=not_defined`, `entitlementGranted=false`. Não há invoices nem definição de conversa faturável. Testes de isolamento e replays concorrentes em PostgreSQL foram adicionados; CI deve ser confirmado no HEAD final. A trava global deny-only da ADR-113 não mudou. [ADR-114](decisions/ADR-114-immutable-technical-usage-observations.md).

## Phase 9 — ADR-113: policy deny-only e quotas observadas (schema 71)

O endpoint `GET /api/v1/tenants/:tenantId/billing/entitlements` apresenta um diagnóstico read-only tenant-scoped de bloqueios de ativação e contagens de staff/canais ativos comparadas com limites do catálogo (sem enforcement). Conversas, mensagens e localizações são declaradas não mensuráveis para faturação até uma política aprovada. A migration 71 cria uma trava global `paid_automation` com `enabled=false` e CHECK que **proíbe** alterá-la para true, RLS forçada e sem grants de escrita. O avaliador responde sempre `allowed=false`, `billingVerified=false`, `automationEnabled=false`, mesmo em snapshots Stripe `active` e cenários adversos.

Testes unitários e HTTP/RLS PostgreSQL foram adicionados; o CI do HEAD final confirma ou invalida a conclusão. Sem E2E Stripe sandbox, billing ledger, quotas transacionais, Customer Portal mutável, merge, deploy ou cobrança live. [ADR-113](decisions/ADR-113-deny-only-entitlements-quota-readiness.md).

## Phase 9 — ADR-112: Customer Portal Stripe TEST estritamente read-only (schema 70)

Foi implementado `POST /api/v1/tenants/:tenantId/billing/portal`, desligado por omissão, limitado a owner/admin, a `NODE_ENV=test` e a uma configuração Stripe test `bpc_...` explicitamente segura. O backend verifica em duas transações independentes autorização/membership/RLS, subscrição e intenção `cs_test_` original, além de consultar o Stripe para conferir subscrição, preço, cliente e configuração sem mutações; só então retorna uma URL efémera no host `billing.stripe.com`. Auditoria `billing.portal.created` sem URL e throttle de 30 segundos por tenant. Migration 70 concede apenas SELECT dos IDs Stripe sob a RLS já forçada.

A integração e os testes automatizados usam fornecedor simulado; confirmar CI verde no HEAD final. Stripe sandbox real e controlo externo da configuração ainda não validados. Não há qualquer alteração ao Flutter, nem alterações contratuais, quotas ou direitos pagos: `billingVerified=false` e `automationEnabled=false`. Sem merge, deploy ou pagamentos live. [ADR-112](decisions/ADR-112-stripe-test-read-only-customer-portal.md).

## Phase 9 — ADR-111: fila e dispatch Stripe TEST com recuperação (schema 69)

Foi implementada uma fila persistente `stripe_event_dispatch`, criada atomicamente pelo inbox de webhook assinado, com leases, backoff limitado e histórico append-only. Um processo de lote manual, explicitamente ativado em teste, consulta a fila através do papel NOLOGIN de dispatcher (aprovado manualmente), e delega associação inicial e reconciliação aos seus próprios papéis restritos, sem credenciais Stripe no worker normal.

O funcionamento continua condicionado a `NODE_ENV=test` e flags específicas. CI de integração PostgreSQL/RLS e provider simulado deve ser confirmado no HEAD final. Stripe sandbox real não validado; não existe fila ativa de produção, merge ou deploy. Nenhum pagamento live nem entitlement está ativo; `billingVerified=false` e `automationEnabled=false` mantêm-se. [ADR-111](decisions/ADR-111-stripe-test-event-dispatch-retry.md).

## Phase 9 — ADR-110: ligação verificada da primeira subscrição Stripe test (schema 68)

Um comando **offline e opt-in para operador em ambiente de teste** consegue agora ligar uma `checkout.session.completed` anteriormente validada e armazenada (ADR-105) à intenção `stripe_checkout_intents` criada pelo servidor (ADR-109). O tenant, plano e preço têm origem na intenção local; nunca em metadata do webhook, nem num redirect. O associador consulta a Checkout Session e a Subscription diretamente no Stripe test, confirma `status=complete`, `payment_status=paid`, customer, ID de subscrição, item único, preço e período, e rejeita divergências. Inserção inicial e auditoria são atómicas, com replay idempotente e proteção contra associações cruzadas.

Migration 68: `subscriptions.checkout_session_id` único, `stripe_checkout_link_attempts` append-only sob RLS forçada, e papel dedicado `melissa_billing_linker` (NOLOGIN por defeito). Login requer script específico num DB de teste. O papel só lê os dados mínimos para ligar e só pode inserir associação verificada, sem alterar/deletar entidades ou eventos, sem privilégios de API/reconciliador. Testes automatizados unitários e integração PostgreSQL/RLS com provider simulado foram adicionados; verificar CI no HEAD final antes de considerar validado. Sem Stripe sandbox real verificado, sem worker, Portal ou cobrança live.

**O link não concede acesso pago:** `billingVerified=false`, `automationEnabled=false` e o bloqueio no onboarding permanecem. O produto ainda exige policy de entitlements, quotas, uso, E2E e aprovação de lançamento. [ADR-110](decisions/ADR-110-stripe-verified-test-checkout-binding.md).

## Atualização Phase 9 — Stripe Checkout test opt-in e intenção durável (ADR-109, schema 67)

Adicionado `POST /api/v1/tenants/:tenantId/billing/checkout` com `billing:write` apenas para owner/admin, sessão de autenticação revalidada e RLS. A migration 67 introduz `stripe_checkout_intents` com `(tenant_id,request_id)` único, uma intenção aberta por empresa, expiração, estado e sessão Stripe única. O backend verifica plano publicado, produto/preço recorrente e preço exato do catálogo contra API Stripe test, usa chamada idempotente a Checkout hospedado e só devolve URL Stripe validado após segunda validação RBAC/RLS. O endpoint permanece desligado por omissão, usa exclusivamente `sk_test` e URL de retorno definida no servidor. Tem tests do provider e fluxo HTTP/PostgreSQL/RLS com Stripe simulado; **o CI e um teste real em Stripe test mode ainda requerem confirmação**.

Esta entrega **não vincula cliente/subscrição inicial Stripe** nem concede direito comercial, não inclui UI de contratação, Portal ou worker. `automationEnabled=false`, `billingVerified=false` e onboarding bloqueado mantêm-se, incluindo em redirect de sucesso ou `checkout.session.completed` recebido. A ligação comprovada, com novo papel mínimo de DB, será o próximo incremento. Ver [ADR-109](decisions/ADR-109-stripe-test-checkout-intent.md).

# Estado do projeto

## Atualização Phase 9 — Ecrã Flutter de faturação apenas consulta (ADR-108, schema 66)

Criado `/billing/:tenantId` em `apps/flutter_app/lib/billing/billing_page.dart` e ligação visível na área `/account` **só para os papéis owner e admin**. O ecrã consulta exclusivamente `GET /api/v1/tenants/:tenantId/billing/plans` e `/billing/subscription`, que continuam autorizados no backend com `billing:read` e RLS. Apresenta catálogo de planos publicados com preço/moeda/intervalo e limites de conversas, staff, canais e localizações; a subscrição da empresa com estado, período, trial e cancelamento no fim do período. Quando não há planos/subscrição, informa explicitamente. Não apresenta dados Stripe sensíveis, nem permite Checkout, pagamentos, upgrades, criação de subscrições ou ativação.

O interface mostra sempre que a automação paga está desativada, **inclusive quando o estado Stripe é `active`**. A leitura falha de forma segura se o backend devolver uma projeção `automationEnabled` ou `billingVerified` desconhecida/ativada: nunca mostra um plano como comprado/autorizado. Pedidos em curso usam controlo de geração e tenant para impedir que uma resposta atrasada mostre dados de outra empresa; cada recarregamento apaga dados antigos antes de consultar a API. 401/403/404 removem a listagem e mostram erro de acesso; falhas de rede, JSON malformado ou falhas transitórias mostram erro genérico sem detalhes de infraestrutura e botão de atualização. Traduções pt/en/es/fr/it/de e layout responsivo rolável.

Testes Flutter abrangem catálogo com preço vindo do backend, ausência de subscrição, snapshot de subscrição ativa sem entitlement, erro 403 seguido de recuperação e backend com entitlement inesperadamente ativado (fail-closed); verificam ainda que não há chamadas HTTP de escrita nem ações de pagamento. **Validação funcional:** [CI #38520032622](https://github.com/HernanyManuel/Melissa/actions/runs/38520032622) integralmente verde no commit `215527ae8156fb4bf34b0ec8627eccdbf2cfa0ef`: backend (formatação/lint/TypeScript, testes unitários e integração PostgreSQL/RLS/Redis com worker real, OpenAPI e audit), Flutter (gen-l10n, análise estrita, widget tests, build Web) e Compose (readiness). O primeiro CI identificou apenas uma lista vazia sem tipo explícito no novo teste Dart, corrigida antes da aprovação. [ADR-108](decisions/ADR-108-flutter-read-only-billing-page.md). Não houve alterações de schema/migration, autorização backend ou envio Stripe, e o PR mantém-se draft sem merge/deploy.

## Atualização Phase 9 — Papel de reconciliação Stripe com privilégios mínimos (ADR-107, schema 66)

A reconciliação da ADR-106 deixou de aceitar `MIGRATION_DATABASE_URL`: exige `BILLING_RECONCILER_DATABASE_URL` separada e verifica na própria operação que `current_user = melissa_billing_reconciler`, não é superuser nem tem `BYPASSRLS`. O papel é provisionado **NOLOGIN por defeito** antes das migrações; a migration 66 concede apenas leitura dos eventos Stripe originais (sem escrita), leitura das associações de subscrição preexistentes, leitura exclusiva do ID/preço Stripe configurado, atualização restrita **somente** às colunas de estado/período/trial/cancelamento da subscrição e inserção/consulta dos registos de auditoria. Não pode criar/substituir tenant, customer, plano, associação comercial, evento assinado ou recibo; nem alterar preço, `tenant_id`, `plan_id`, `provider_customer_id` ou apagar auditoria. RLS permanece `FORCE`, com políticas explícitas por papel. A API e o worker mantêm o role `melissa_runtime` e não recebem novas permissões ou credenciais.

Um ficheiro separado `infra/scripts/billing-reconciler-login.sql` ativa LOGIN e senha própria somente por **ação explícita de operador em ambiente de teste**. CI cria e usa uma senha descartável distinta das credenciais runtime/migração, e os testes PostgreSQL executam a função real pelo papel restrito; uma chamada pelo administrador é rejeitada. O reconciling continua **offline, manual, Stripe test-only**, sem conceder entitlements, não cria novas subscrições, não cobra ou ativa serviços, não implementa Checkout/Portal nem worker de pagamentos. A janela de permissões não substitui um sandbox Stripe real. Ver [ADR-107](decisions/ADR-107-stripe-dedicated-reconciler-role.md). **CI funcional:** [CI #38352760844](https://github.com/HernanyManuel/Melissa/actions/runs/38352760844) **integralmente verde** no commit `124d143052cf7042d5cbabf8e0c4007818cf1d24`: backend (formatação, lint, TypeScript, unitários, PostgreSQL/RLS com worker/Redis real, OpenAPI e auditoria), Flutter (análise, testes e build Web) e Compose (readiness). O CI detetou que o ORM inseria explicitamente `created_at` na auditoria, exigindo um grant demasiado amplo; foi corrigido para `INSERT` SQL parametrizado que deixa o timestamp ao PostgreSQL, conservando estritamente os grants de cinco colunas.

## Atualização Phase 9 — Reconciliador Stripe test de subscrições pré-associadas (ADR-106, schema 65)

Implementado reconciliador **offline, manual e opt-in exclusivamente de teste** (não faz parte do servidor API ou de um worker contínuo). O comando `NODE_ENV=test STRIPE_TEST_RECONCILE_ENABLED=true STRIPE_TEST_SECRET_KEY=sk_test_... BILLING_RECONCILER_DATABASE_URL=... pnpm --filter @melissa/backend stripe:reconcile-test evt_...` obtém um evento *já assinado e persistido* em `stripe_webhook_events`, extrai apenas o ID de subscrição permitido e procura uma associação Stripe **já existente e globalmente única** em `subscriptions.provider_subscription_id`. Ignora completamente `metadata.tenant_id` para escolher empresa. Eventos sem associação prévia ficam `unmapped`, sem criação de subscrição ou consulta a IDs desconhecidos.

Só depois de bloquear a linha da subscrição no PostgreSQL (`FOR UPDATE`) consulta o **Stripe API test** atual (`GET /v1/subscriptions/:id`, host fixo, HTTPS, `sk_test_`, `Stripe-Version: 2025-09-30.clover`, sem redirects, 5 s, resposta máx. 128 KiB). Exige `livemode=false`, correspondência exata entre ID de subscrição, ID de cliente, plano/Stripe price já configurado e exatamente **um único item** com período correto. Desde Stripe API 2025-03-31.basil os períodos de faturação são **`items.data[].current_period_start/end`**, não os campos no topo; objetos com vários itens, datas incoerentes ou preços diferentes são recusados. Um evento antigo `subscription.deleted` ou `invoice.paid` obtém o **estado atual do provider**, não aplica o estado antigo do payload. O update e um registo de auditoria são atómicos; os fetches concorrentes para a mesma linha são serializados. `stripe_reconciliation_attempts` no schema 65 regista `applied|unmapped|rejected|deferred|skipped` com códigos seguros, sem copiar dados do cliente nem o payload completo, com RLS forçada e **nenhuma concessão de acesso ao role `melissa_runtime`**.

O algoritmo não faz Checkout, Portal, nova associação cliente/tenant, upgrades/downgrades de preço, proration, impostos, cobrança, emissão de invoices ou entitlement. `billingVerified=false`, `automationEnabled=false` e o blocker `subscription` mantêm-se independentemente do estado `active`; não foram disponibilizadas mutações de billing via HTTP. Por utilizar **`MIGRATION_DATABASE_URL` de operador privilegiado**, a ferramenta é estritamente manual/ambiente de teste: antes de criar workers ou ativar em produção será obrigatório um **role dedicado de mínimos privilégios**, nova política de ativação e integração Stripe externa demonstrada. Sem deploy, merge ou credenciais test/live guardadas no repositório.

Testes de integração PostgreSQL via role administrativo cobrem associação A/B com metadata maliciosa, eventos fora de ordem, invoice Basil, período por item, múltiplos itens, customer mismatch, price mismatch, live mode, falha de provider, replay idempotente, unicidade da subscrição e auditabilidade. **CI funcional:** [run #38274571857](https://github.com/HernanyManuel/Melissa/actions/runs/38274571857) integralmente verde sobre `091f0cb78eb0986cddbf76335a4865c6f46eecdc`: backend (Prisma schema 65/migração, formatação/lint/TypeScript, unitários, integração PostgreSQL/RLS e worker/Redis real, OpenAPI), Flutter (análise, widgets, build Web) e Compose. Corrigidas a tipagem Prisma da fixture e a paginação completa nas respostas simuladas Stripe antes do CI verde. Ver [ADR-106](decisions/ADR-106-stripe-test-subscription-reconciliation.md).

## Atualização Phase 9 — Ingestão assinada Stripe em teste e event inbox imutável (ADR-105, schema 64)

Foi implementado `POST /webhooks/stripe` como **ingress test-mode**, desativado por omissão via `STRIPE_WEBHOOK_ENABLED=false`, com segredo server-side `STRIPE_WEBHOOK_SECRET=whsec_...` exigido quando se habilita em ambiente de testes controlado. A middleware express.raw com limite de 256 KiB, `inflate:false` e content-type JSON corre antes do parser Nest, de modo que a assinatura v1 HMAC-SHA256 é calculada sobre **bytes originais**, timestamp `t` com tolerância de 300 segundos, comparada em tempo constante (com múltiplas assinaturas v1 para rotação). Pedidos sem assinatura/vencidos/adulterados devolvem 403; envelope inválido devolve 400 e `livemode=true` é recusado. Não existem chaves Stripe live nem SDK de pagamento neste incremento.

A migration 64 adiciona `stripe_webhook_events` global, sem `tenant_id` arbitrário fornecido pelo evento: `event_id` como PK, tipo, data provider, hash SHA-256 do payload original, JSONB integral e status fixo `received` (sem processamento). `ON CONFLICT DO NOTHING RETURNING` torna a persistência idempotente e o conflito de mesmo ID com hash/tipo diferentes devolve 409. Os 6 tipos relevantes são guardados; tipos desconhecidos mas assinados são ignorados com ACK. A tabela tem RLS forçada e política específica para `melissa_runtime`: **INSERT de evento test-mode** e SELECT **apenas** de ID/tipo/hash para comparação; nunca leitura do JSON sensível pelo runtime, nem UPDATE/DELETE. O payload ficará acessível apenas ao futuro reconciliador privilegiado, sob retenção e auditoria definidas mais tarde. Nenhum evento é associado a um tenant confiando em `metadata.tenant_id`.

**Não existem alterações de subscrição, pagamentos, entitlements, faturação, emissão de mensagens, workers live ou onboarding:** apenas ACK de receção durável. Uma assinatura válida **não** concede autorização comercial. Permanecem por desenvolver reconciliador (provider fetch, eventos fora de ordem, mapping e fence do tenant), outbox/worker, Checkout/Portal Stripe test, métricas/custos, limites e UI, além dos testes reais com Stripe CLI em sandbox. Os testes integrados abrangem assinatura/expiração/test-mode, 200/400/403/409/415, deduplicação e preservação do payload/hash, restrições RLS/grants e ausência de ativação. **CI:** verificar no último commit. Ver [ADR-105](decisions/ADR-105-signed-stripe-test-webhook-inbox.md). Sem merge ou deploy.

## Atualização Phase 9 — Catálogo e snapshot de subscrição read-only (ADR-104, schema 63)

Começou a Phase 9 com a migração 63, implementando `plans` (catálogo global configurável, preço/custo em `NUMERIC(20,6)`, moeda, intervalo, quotas, features JSONB, referências Stripe e ativação) e `subscriptions` (uma snapshot por tenant, período e status provider, referências externas não expostas na API). Existem CHECKs de estados/preços/cotas/períodos, chaves/FKs e UNIQUE da subscrição provider e tenant. A tabela de subscrições tem **RLS forçada** por `app.tenant_id`. O role `melissa_runtime` recebe apenas SELECT nas colunas necessárias: **sem INSERT, UPDATE ou DELETE** de planos/subscrições, sem leitura de IDs Stripe. A migração não publica preços de exemplo, cria planos por omissão, cobra, ativa tenants ou escreve qualquer snapshot.

A API autenticada `GET /api/v1/tenants/:tenantId/billing/plans` lista apenas planos `active=true` configurados por operador privilegiado, sem IDs Stripe; `GET /api/v1/tenants/:tenantId/billing/subscription` lê a snapshot apenas do tenant e apresenta o plano permitido, período, estado e `entitlements: {automationEnabled:false,billingVerified:false,reason:'billing_not_enabled'}` **sempre**, inclusive para uma linha de teste com `status='active'`. Ambas exigem `billing:read` (owner/admin) com sessão válida, RBAC e scope RLS. Nenhum redirect ou chamada HTTP concede uma subscrição ou ativa automação. O onboarding mantém o blocker de assinatura e `activation.allowed=false`. Readiness passa a exigir schema 63.

Testes HTTP/PostgreSQL com role real (sem bypass RLS) verificam 401/403/404, preços lidos da DB, planos inativos ocultos, ausência de IDs de provider na resposta, subscrição isolada entre tenants, revogação de escrita ao runtime, SELECT sem contexto incapaz de ler snapshots, catálogo sem mutação via API e fail-closed mesmo com status `active`. **CI funcional:** [run #38244880710](https://github.com/HernanyManuel/Melissa/actions/runs/38244880710) integralmente verde sobre `9b1484bef1641741f4bd72a39151cb29c39ddc90`: backend (Prettier, lint, TypeScript strict, unitários, integração com PostgreSQL/RLS e worker real, recuperação Redis, OpenAPI, audit), Flutter (análise, widgets e build Web) e Compose readiness. A primeira execução de CI expôs formatação e três assertions de resultados SQL opcionais no novo teste; corrigidos com `prettier-ignore` e guards explícitos antes da execução bem-sucedida. Ver [ADR-104](decisions/ADR-104-billing-catalog-subscription-read-only-foundation.md).

**Ainda falta Phase 9:** contratação com Stripe test Checkout/Portal, webhooks com assinatura e event store/outbox idempotentes, estado reconciliado com provider, gestão de upgrades/downgrades/trials/grace, EntitlementService que só autoriza após verificação, budgets e quotas de utilização, custos reais, overages, impostos/invoices e UI. Não realizar cobrança real antes de decidir a unidade faturável e preços. Sem merge, deploy ou integração Stripe/Meta/Google ativa.

## Atualização Phase 8 — Pedidos persistentes de atendimento humano (ADR-103)

O endpoint tenant-scoped `GET /api/v1/tenants/:tenantId/inbox/handoff-summary` devolve `{pendingConversations}` com a contagem atual de conversas **abertas** em `WAITING_HUMAN`, através de `TenantService.scoped(messages:read)` e PostgreSQL/RLS. A contagem não depende de filtros/páginas do operador ou da entrega de eventos SSE; takeover e outras transições removem automaticamente a conversa da fila. O filtro existente `controlMode` ganhou `waiting`, aplicado ao predicado partilhado de cursor, à via Prisma normal e ao SQL parametrizado de `unreadOnly=true` **antes de LIMIT 51**. Cursores de outro estado devolvem 404.

O Flutter apresenta uma entrada no **ListView rolável** do inbox quando existem pedidos pendentes, com contador tenant-wide e navegação direta à lista `waiting` sem aumentar a altura fixa do cabeçalho. Atualiza após REST inicial, paginação/refresh SSE->REST e controlo humano; ignora respostas assíncronas antigas após troca de tenant ou perda de acesso. Traduções pt/en/es/fr/it/de. Testes HTTP cobrem contagem 0→51→50, isolamento cross-tenant, 50+1, combinação com `unreadOnly` e `sort=recent`, rejeição de cursores incompatíveis; widget tests cobrem alerta, filtro, desaparecimento ao resolver e recuperação após reload.

**Validação funcional:** [CI #38240681100](https://github.com/HernanyManuel/Melissa/actions/runs/38240681100) **integralmente verde** no commit `9a740fec22259f6a7584e1787a4f1c23ec5d7903`: backend com formatação/lint/tipos, unitários, integração PostgreSQL/RLS, worker/Redis restart e recovery, OpenAPI e auditoria; Flutter gen-l10n/analyze/widget tests/build Web; Compose readiness. O primeiro CI detetou dois avisos de análise Dart (chavetas), corrigidos; o seguinte identificou um 404 num teste de SSE com API sem o endpoint opcional. O 404 deste **resumo adicional** passa a esconder apenas o alerta, sem apagar um Inbox autorizado; 401/403 mantêm revogação, e um widget test novo fixa essa compatibilidade. [ADR-103](decisions/ADR-103-durable-pending-handoff-attention.md). **Schema 62**, sem migração, envio, worker novo, efeitos de IA, fallback mock ou alteração de fencing/checkpoints. **Limites:** é uma fatia in-app de atenção **enquanto a conversa aguarda humano**, não o NotificationService completo: não há entrega por email/push, caixa de notificações independente, preferências, marcação como lida ou recibos por ator; continuam planeados na Phase 8. Sem merge, deploy nem ativação Meta/Google/Stripe.

## Atualização Phase 8 — Janela fixa de atividade recente no inbox (ADR-102)

O endpoint `GET /tenants/:tenantId/conversations` aceita agora `activitySince=<UTC>`: limite inclusivo de `lastMessageAt` em formato rigoroso `YYYY-MM-DDTHH:mm:ss.SSSZ`. Data inválida, fuso não-UTC, precisão ou formato incompatível devolvem 400. Omisso mantém a listagem anterior. O valor é **fixo e reutilizado** em toda a paginação, não uma janela móvel `now()-N` recalculada no servidor. O filtro exige `messages:read`, respeita tenant/RLS, combina com pesquisa, atribuição, estado, controlo da conversa, etiquetas, canal e `sort=id|recent`, incluindo a via SQL de `unreadOnly=true` antes de `LIMIT 51`. Cursores fora do intervalo passam a devolver 404 conforme a ADR-101.

O Flutter inclui opções compactas de **toda a atividade**, **últimas 24 horas**, **7 dias** e **30 dias**, traduzidas em pt/en/es/fr/it/de. Ao selecionar uma janela, calcula e guarda uma única data UTC em milissegundos; `activitySince` é preservado nas páginas e no refresh REST/SSE e validado contra respostas atrasadas. Alterar o período reinicia a paginação e mantém os outros filtros; trocar de tenant ou perder autorização limpa a janela. O catálogo de etiquetas e ligações, as mensagens e a receção SSE não são alterados.

Testes backend verificam validade de formato/data, tenant, cursor incompatível, inclusão da fronteira, paginação de 51 conversas com timestamp igual, combinação com estado e ordenação recente, e resultado na via SQL de não lidas. Widget test confirma valor UTC fixo entre mudanças de ordenação/filtro/páginas, mudança para uma janela mais longa e retorno a toda a atividade. **CI funcional:** [run #38226730460](https://github.com/HernanyManuel/Melissa/actions/runs/38226730460) **integralmente verde** no commit `a1c243e283d85e72d5b65801bde5210f1c001153`, após format/lint/tipos/unitários, integração PostgreSQL/RLS com worker real, recuperação worker/Redis, OpenAPI e auditoria backend; Flutter gen-l10n/analyze/widgets/build Web; e Compose readiness. A primeira execução evidenciou overflow em testes antigos do inbox a 800×600 após acrescentar um ícone na área de filtros; o seletor foi colocado no cabeçalho compacto e todos os testes passaram. [ADR-102](decisions/ADR-102-inbox-fixed-activity-window-filter.md). **Schema 62**, sem migração nem alteração a worker, envio, idempotência, fencing ou checkpoint.

**Limites:** `lastMessageAt` é a última atividade gravada, não a hora de última mensagem inbound exclusivamente. A janela não cria um snapshot de leitura entre pedidos; mensagens recebidas posteriormente podem deslocar conversas no `sort=recent`. Nenhum merge, deploy ou ativação live.

## Atualização Phase 8 — Cursores vinculados a todos os filtros e recuperação segura (ADR-101)

A validação de `after` em `GET /tenants/:tenantId/conversations` cobre agora **todos** os critérios ativos, incluindo `assignment=mine|unassigned`, pesquisa literal `q` e o estado `unreadOnly=true` por ator, além de tenant, status, modo de controlo, ligação, modo da ligação e etiqueta. Um cursor cuja conversa deixou de pertencer à lista selecionada devolve 404, mesmo que o UUID exista no tenant. `sort=id|recent` mantém a mesma validação; tanto Prisma como SQL de não lidas selecionam e ordenam antes de `LIMIT 51`.

O backend usa um único predicado `visibleWhere` Prisma para validar o cursor e listar o conjunto de conversas sem `unreadOnly`, evitando que os filtros divirjam. Com `unreadOnly=true`, faz ainda uma verificação SQL parametrizada de evento inbound posterior ao cursor de leitura do **ator autenticado**, sempre dentro da transação tenant/RLS; a seleção paginada continua a usar a via SQL existente. Assim, atribuições alteradas, pesquisas modificadas e marcações como lida não deixam continuar a partir de um cursor estranho ao filtro.

No Flutter, apenas um **404 de uma página seguinte** desencadeia um novo pedido à **primeira página com os filtros e a ordenação atuais**. A geração da lista invalida respostas atrasadas; não há ciclo infinito de retry. Erros 403/401 e falhas de rede conservam a política anterior de limpar o estado sensível e apresentar ação de recuperação. Testes HTTP verificam cursores incompatíveis, combinação com a ordem recente, transição de atribuição, pesquisa e leitura por ator; widgets verificam recuperação de 404 sem mesclar linhas antigas e segurança de 403.

**Validação:** [CI #38222725283](https://github.com/HernanyManuel/Melissa/actions/runs/38222725283) **integralmente verde** no commit `db4b2a615101ccd056cfed08b21ad97920b35a28`: backend (formatação/lint/tipos/unitários, integração HTTP com PostgreSQL/RLS e worker real, recuperação Redis/restart, OpenAPI e auditoria), Flutter (gen-l10n/analyze/widget tests/build Web) e Compose readiness. O primeiro CI expôs uma corrupção sintática na edição do serviço, corrigida; o seguinte identificou a espera demasiado curta num teste de calendário independente, estabilizada ao aguardar o estado `processed` da outbox, sem modificar a lógica de produção. [ADR-101](decisions/ADR-101-inbox-cursor-full-filter-validation-and-recovery.md). **Schema 62**, sem migração, efeitos colaterais, workers, alterações a outbox/fencing, reenvios ou checkpoints SSE.

**Limites:** a paginação continua a refletir alterações concorrentes entre pedidos, não um snapshot temporal; uma resposta 404 para página seguinte pode também indicar revogação, pelo que o refresh inicial mantém o controlo de acesso e limpa a lista se falhar. Sem merge, deploy, notificações externas nem ativação live.

## Atualização Phase 8 — Ordenação opcional por atividade recente (ADR-100)

O `GET /tenants/:tenantId/conversations` recebe `sort=id|recent`. O valor omisso ou `id` preserva a ordenação anterior (`id ASC`); `recent` ordena por `lastMessageAt DESC, id DESC`, colocando a atividade mais recente primeiro e resolvendo empates pela chave única da conversa. Valores desconhecidos ou em maiúsculas são rejeitados com HTTP 400. A consulta exige `messages:read` e conserva tenant/RLS/RBAC, todos os filtros anteriores (`q`, `tagId`, `channelId`, `channelMode`, `controlMode`, `status`, `assignment`, `unreadOnly`) e páginas de 50.

Na via Prisma, o cursor por UUID e `orderBy` composto formam a paginação keyset; na via SQL `unreadOnly=true`, o filtro de cursor usa a comparação precisa no PostgreSQL `(last_message_at,id) < (last_message_at_do_cursor,id_do_cursor)`, dentro do tenant, antes de `LIMIT 51`. Um cursor inexistente ou incompatível com o tenant/estado/canal/etiqueta devolve 404. Não se ordena em memória após a paginação nem se transforma o timestamp em milissegundos no cliente. O índice existente `(tenantId,lastMessageAt,id)` suporta a ordenação sem migração.

Flutter acrescenta um menu compacto no cabeçalho para alternar entre ordem anterior e atividade recente, com tradução pt/en/es/fr/it/de. Uma mudança de ordem limpa o cursor anterior, mantém os outros filtros e descarta resultados de refresh REST/SSE iniciados na ordem antiga. Testes de integração cobrem empates de timestamp, fronteira de 50/52, página 2, modo por canal, RLS, valores inválidos, ordem predefinida e a via não lidas; testes Flutter verificam composição, paginação e reset.

**CI funcional:** [run #38220494598](https://github.com/HernanyManuel/Melissa/actions/runs/38220494598) **integralmente verde**, commit `f8958a59c87967ebe79344f284c01dabac05be6b`, com backend (formatação, lint, tipos, unitários, PostgreSQL/RLS, integração com worker separado, recuperação worker/Redis, OpenAPI e audit de produção), Flutter (gen-l10n/analyze/test/build Web) e Compose readiness. [ADR-100](decisions/ADR-100-inbox-recent-activity-keyset-sort.md). **Schema 62**, sem migrações, mudanças no worker ou alterações a envios, outbox, fencing, idempotência e checkpoints SSE.

**Limites:** com novas mensagens e reordenações concorrentes entre chamadas, as páginas não são um snapshot congelado e uma conversa pode subir de posição; um refresh ou reinício da listagem reconcilia os resultados. `lastMessageAt` é a atividade registada, não uma garantia de entrega ou disponibilidade do provider. Sem notificações push/email ou E2E Meta live.

## Atualização Phase 8 — Triagem pelo controlo atual da conversa (ADR-099)

O inbox aceita agora `controlMode=all|human|ai|paused` em `GET /tenants/:tenantId/conversations`. Os valores correspondem estritamente ao estado persistido `HUMAN_ACTIVE`, `AI_ACTIVE` e `AI_PAUSED`; a omissão/`all` preserva todos os estados anteriores, incluindo `CLOSED`. Isto é distinto de `channelMode`, que classifica a **ligação** (`mock/live`). O filtro é apenas de leitura, exige `messages:read` e é aplicado na transação tenant/RLS, antes de `LIMIT 51`, tanto na consulta Prisma como na via SQL `unreadOnly=true`.

A composição mantém filtros de estado open/closed, atribuição, canal específico, modo do canal, etiqueta, pesquisa e não lidas por operador. `after` tem de identificar uma conversa do tenant que ainda pertença ao estado de controlo selecionado; caso contrário dá 404. Alterações concorrentes entre páginas podem invalidar o cursor, sem permitir leitura fora do filtro. Nenhuma ação de takeover, reativação, fecho ou resposta é desencadeada pela escolha.

No Flutter, o seletor de controlo encontra-se no cabeçalho do inbox, sem aumentar a altura dos filtros em ecrãs estreitos; rótulos pt/en/es/fr/it/de. O filtro acompanha as páginas, refresh REST/SSE e geração de listagem, e reinicia o cursor ao ser alterado. Testes HTTP abrangem estados após takeover/reativação/fecho, autorização de tenant, validação, combinação com não lidas e paginação de 52 conversas em pausa. Testes de widget verificam combinação, paginação e reset.

**Validação:** [CI funcional #38215255905](https://github.com/HernanyManuel/Melissa/actions/runs/38215255905) **integralmente verde** no commit `8e2e85760be43ff4194a89a26f3c04019ec7c293`: formatação, lint, tipos, unitários, PostgreSQL/RLS e integração com worker separado, recuperação após restart/Redis, OpenAPI, auditoria de dependências, Flutter analyze/test/build Web e Compose readiness. A primeira execução identificou uma única questão de formatação do DTO, corrigida sem mudança semântica. [ADR-099](decisions/ADR-099-inbox-control-state-triage.md). **Schema 62**, sem migração nem alteração aos workers, envios, idempotência, fencing ou checkpoints.

**Limites:** `HUMAN_ACTIVE` representa o controlo persistido, não a presença online de um operador; `AI_PAUSED` não equivale a um erro de provider. Nenhuma notificação externa, merge, deploy ou ativação real foi efetuada.

## Atualização Phase 8 — Triagem por ligação exata do canal (ADR-098)

O inbox aceita agora `GET /tenants/:tenantId/conversations?channelId=<uuid>`, combinável com `channelMode`, `status`, `assignment`, `tagId`, `q` e `unreadOnly`. A ligação deve existir no tenant autorizado; parâmetro inválido devolve 400, ligação ausente/cross-tenant devolve 404. Tanto Prisma como a via SQL de não lidas filtram **antes da paginação** e exigem correspondência do cursor `after` com a ligação, evitando misturar páginas de canais diferentes.

Novo `GET /tenants/:tenantId/inbox/channel-options?after=<uuid>` com `messages:read`: devolve apenas **id, displayName e mode** das ligações que já têm conversas no mesmo tenant, ordenadas por ID e paginadas a 50. Exclui credenciais, identificadores externos, metadados do provider e ligações sem conversas. Cursores desconhecidos ou de outro tenant são rejeitados com 404. O endpoint de administração de canais continua separado e protegido por `channels:manage`.

No Flutter há um painel compacto de seleção de ligação, com paginação «Carregar mais ligações», escolha «Todas as ligações», localizações pt/en/es/fr/it/de, recuperação de erro e invalidação de callbacks antigos após troca de tenant. A seleção persiste em páginas e refreshes SSE/REST e reinicia o cursor quando muda. Testes de integração abrangem autorização, projeção mínima, canais mock/live, composição com não lidas, cursores e catálogo com 60 ligações; widgets cobrem paginação do catálogo, filtros e isolamento após mudança de tenant.

**Validação:** [CI #38213970910](https://github.com/HernanyManuel/Melissa/actions/runs/38213970910) **integralmente verde**, no commit `2c226ee6dec7c6a6f6e3230e0aff7b11334330b5`: backend PostgreSQL/RLS, integração HTTP, unitários, worker restart/Redis, OpenAPI e audit; Flutter analyze/test/build web; Compose readiness. A implementação também endureceu duas fixtures de integração preexistentes: o teste WhatsApp deixa de selecionar um cliente arbitrário com conversa prévia e a descoberta global de despachos de calendário já não assume isolamento entre suites paralelas. O seletor foi compactado para evitar overflow na barra lateral estreita. [ADR-098](decisions/ADR-098-inbox-exact-channel-connection-filter.md). O schema mantém-se em **62**. Sem endpoints de escrita, novos dispatches, alterações a worker, merge, deploy ou integração live.

**Limites:** é filtragem operacional pelo identificador da ligação, não gestão de canais ou prova de disponibilidade do provider. O catálogo não inclui ligações sem conversas; as páginas não constituem snapshot atómico se houver criação de canais concorrente. Continuam pendentes notificações externas, operações avançadas de atendimento e E2E real com Meta.

## Atualização Phase 8 — Triagem por modo do canal (ADR-097)

O inbox permite filtrar conversas por modo da ligação ao canal: `channelMode=all|mock|live` no `GET /tenants/:tenantId/conversations`. A omissão e `all` preservam o resultado anterior; valores inválidos são rejeitados com HTTP 400. O filtro é aplicado no PostgreSQL **antes da paginação** nas duas vias existentes (Prisma normal e SQL de `unreadOnly=true`), com a mesma autorização `messages:read`, isolamento tenant/RLS e procura, etiquetas, atribuição e estado já implementados. Um cursor `after` de conversa cujo modo não corresponda devolve 404; nenhuma credencial, identificador de provider ou dado pessoal adicional é projetado.

O Flutter apresenta um seletor compacto e localizado em pt/en/es/fr/it/de, mantém o modo na paginação e nos refreshes SSE por REST, descarta respostas tardias para filtros alterados e reinicia a paginação quando o operador muda o modo. O filtro não executa takeover, marcação de leitura nem qualquer envio; não cria novos endpoints de escrita, filas, workers ou migração (schema permanece 62). Testes HTTP cobrem isolamento, valores inválidos, combinação com não lidas/estado e cursor incompatível; testes Flutter cobrem filtro, composição e paginação.

**Validação:** [CI funcional #38201834312](https://github.com/HernanyManuel/Melissa/actions/runs/38201834312) **integralmente verde** no commit `f50fb0a0e0f2a001d192a9191a6fde9d4b67c818`: backend (formatação, lint, tipos, unitários, PostgreSQL/RLS e integração com worker separado, recuperação após restart/Redis, OpenAPI, audit), Flutter (analyze/test/build web) e Docker Compose. O primeiro CI da fatia falhou devido a uma fixture de teste `mock` que não respeitava a constraint `mock:` dos IDs externos; o commit `f50fb0a` corrigiu-a sem alterar schema nem produção. [ADR-097](decisions/ADR-097-inbox-channel-mode-filter.md).

**Limites:** modo `mock/live` é uma característica da ligação atual, não um indicador garantido de entregabilidade do provider; ainda não existe triagem por ligação específica, notificações push ou E2E Meta live. Nenhum merge, deploy ou ativação de serviços externos.

## Atualização Phase 8 — Contexto histórico multicanal no perfil do cliente

O painel de cliente da conversa apresenta agora até **cinco outras conversas do mesmo cliente**, ordenadas por última atividade (`lastMessageAt DESC, id DESC`), com nome do canal, estado e data local. `GET /tenants/:tenantId/conversations/:id/customer` mantém o objeto original `item` e acrescenta `relatedConversations: {items, hasMore}`, consultando no máximo seis linhas para aferir se há mais registos. A seleção está vinculada ao **tenant e ao customerId da conversa autorizada**, com permissão `customers:read`; não expõe conteúdo de mensagens, notas internas, estado da IA ou credenciais do provider.

O Flutter apresenta os resultados numa lista de altura limitada para ecrãs pequenos, sem abrir outras conversas, marcar mensagens como lidas ou enviar respostas. Traduções para pt/en/es/fr/it/de; sem migração, novo endpoint de escrita ou ativação de serviços externos.

**CI funcional:** [38197394746](https://github.com/HernanyManuel/Melissa/actions/runs/38197394746) **integralmente verde** (backend PostgreSQL/RLS/worker, Flutter analyze/test/build web, Compose) no commit `87579d4f7f0cd017137ba4b149cdd28ba58c91c1`. Os testes verificam limite cinco, ordenação, exclusão da conversa atual e de outro cliente, restrição de tenant, projeção mínima e representação Flutter sem qualquer envio. [ADR-096](decisions/ADR-096-bounded-cross-channel-customer-history.md).

**Limites:** é um resumo de conversas, não uma cronologia completa de mensagens, reservas ou compras; são necessárias fontes, permissões e políticas de retenção próprias antes de acrescentar outros dados sensíveis. Não existe merge, deploy ou E2E Meta live.

## Atualização Phase 8 — Totais globais de mensagens por ler por operador

O novo `GET /tenants/:tenantId/inbox/unread-summary` calcula `unreadConversations` e `unreadMessages` em **todo o tenant autorizado**, independente dos filtros/páginas do inbox. Apenas eventos duráveis `message.received` depois do cursor pessoal `inbox_read_cursors` contam; eventos enviados, mudanças de modo ou checkpoints SSE não contam. A rota exige `messages:read`, associa o cursor ao ator autenticado e utiliza as mesmas restrições tenant/RLS do resto do inbox.

No Flutter, o resumo **global do tenant** aparece separadamente do resumo **local da lista carregada**. Os totais globais são atualizados após consulta de lista, refresh SSE confirmado por REST e ação explícita «Marcar como lida»; erros escondem valores globais antigos e respostas atrasadas de outro tenant são descartadas. Rótulos localizados em pt/en/es/fr/it/de, sem migração adicional ou alteração do envio.

Testes HTTP abrangem dois operadores com confirmações distintas, outros tenants e papéis sem acesso; testes Flutter abrangem filtros, SSE, leitura e resposta antiga após troca de tenant. **CI funcional:** [38173756512](https://github.com/HernanyManuel/Melissa/actions/runs/38173756512) **integralmente verde** (backend PostgreSQL/RLS/worker, Flutter analyze/test/build web e Compose) no commit `c85b535c5c81ba6a3f04ea4d4c80ebe4d9b085ec`. [ADR-095](decisions/ADR-095-tenant-wide-actor-unread-summary.md).

**Limites:** as consultas REST distintas não partilham snapshot atómico; os contadores representam eventos por ler, não prova de visualização. Podem requerer otimização/indexação em tenants de alto volume. Não são notificações push, não incluem alterações de permissões de atribuição e não autorizam deploy, merge nem Meta live.

## Atualização Phase 8 — Checkpoint SSE durável após reload

A migração **62** acrescenta `inbox_stream_checkpoints` por `(tenant_id, actor_id)`, com FK para um evento real do mesmo tenant, RLS forçada por tenant e operador, e grants mínimos à role runtime. O `GET /inbox/checkpoint` recupera o último cursor aplicado e o `POST /inbox/checkpoint` exige `messages:read`, valida que a sequência existe no tenant e impede regressão, duplicação com efeito ou posições futuras. O readiness exige `schema_version=62`.

No Flutter, o início de uma sessão no inbox recupera o checkpoint antes de abrir o stream. A posição persistente avança **só após o refresh REST autorizado ter atualizado a vista**; falhas de REST conservam os eventos pendentes, e falhas temporárias na gravação resultam em replay seguro num próximo reload. O cursor SSE continua **separado** do comando explícito de marcar mensagens como lidas. Trocar de tenant invalida streams e callbacks antigos.

**CI funcional:** [38168100442](https://github.com/HernanyManuel/Melissa/actions/runs/38168100442) integralmente verde (backend PostgreSQL/RLS/worker, Flutter analyze/test/build web e Compose), com testes de isolamento entre operadores, cursores inválidos, monotonicidade e reload após falha REST. [ADR-094](decisions/ADR-094-durable-actor-scoped-inbox-sse-checkpoints.md).

**Limites:** checkpoint não representa prova de leitura nem sincronização integral de todas as páginas; vários separadores do mesmo operador partilham a posição durável, mas cada vista reconsulta o REST ao abrir. Não há notificações fora da aplicação, nem E2E Meta real, merge ou deploy.

## Atualização Phase 8 — Filtro por estado aberto/encerrado

A listagem `GET /conversations` aceita agora `status=all|open|closed` e aplica a condição **antes** de paginação, tanto na consulta padrão como no caminho `unreadOnly=true`. O backend valida o valor (HTTP 400 para inválidos) e exige que um cursor `after` pertença ao tenant e ao estado filtrado (HTTP 404 em caso contrário). Pesquisa, etiqueta, atribuição e cursor continuam combináveis; o estado omitido mantém a listagem prévia, incluindo conversas arquivadas quando existirem.

No Flutter, um menu compacto «Todos os estados / Abertas / Encerradas» evita aumentar a altura fixa dos controlos no telemóvel. Mudanças de estado reiniciam a paginação, e o refresh SSE conserva/verifica a seleção antes de mostrar resultados atrasados. Os rótulos existem em pt/en/es/fr/it/de. Não há novo endpoint de escrita, migração ou efeito sobre a entrega de mensagens.

**Validação:** [workflow 38139479035](https://github.com/HernanyManuel/Melissa/actions/runs/38139479035) **integralmente verde** — backend/PostgreSQL/RLS/worker, Flutter analyze/test/build web e Compose. Testes cobrem alterações reais `open → closed`, `unreadOnly` combinado, etiquetas, cursores incompatíveis, isolamento tenant e UI/paginação; [ADR-093](decisions/ADR-093-inbox-conversation-status-filter.md).

**Limites:** `archived` fica apenas na vista «Todos os estados»; não existe reabertura automática, alteração de estado via filtro, notificações push ou merge/deploy. A Phase 8 mantém pendentes operações avançadas de atendimento e validação E2E Meta real.

## Atualização Phase 8 — Resumo local de mensagens por ler

O inbox Flutter mostra o número de **conversas** com mensagens não lidas e o número de **eventos de entrada ainda não marcados como lidos** nas conversas atualmente carregadas, respeitando pesquisa, etiqueta, atribuição, filtro de não lidas e paginação. O resumo é explicitamente local à lista carregada — não representa um total global de tenant nem revela conteúdo das mensagens. A interface usa contagens `unreadCount` já produzidas pelo backend sob RLS por operador; não requer endpoint novo, migração ou alteração de permissões.

Os rótulos estão disponíveis em pt/en/es/fr/it/de, e o teste Flutter confirma que alterar a pesquisa atualiza ambas as contagens, sem herdar números do filtro anterior. **CI funcional:** [38114724780](https://github.com/HernanyManuel/Melissa/actions/runs/38114724780). Sem merge/deploy, push, áudio nem ativação de WhatsApp live.

## Atualização Phase 8 — Consentimento de marketing no painel do cliente

O painel do cliente no inbox apresenta agora o campo **`marketingConsentStatus`** já existente no endpoint autorizado `GET /tenants/:tenantId/conversations/:id/customer`, com rótulo localizado em pt/en/es/fr/it/de. O campo é estritamente de consulta: o Flutter não altera o consentimento, não faz pedidos de envio, não apresenta a informação como uma autorização de marketing e não cria rotas adicionais. O teste do painel valida a renderização do valor e a ausência de chamadas ao endpoint de mensagens.

Esta alteração é apenas de Flutter/testes/localização; **não requer migração Prisma**, nem modificações de permissões. O endpoint continua a aplicar `customers:read` e o isolamento por tenant preexistentes. Mantêm-se pendentes gestão formal de consentimentos, política de dados pessoais, notificações fora da aplicação e E2E com Meta real; sem merge, deploy nem ativação de WhatsApp live.

## Atualização Phase 8 — Triagem por atribuição de colaborador

A listagem de conversas aceita o parâmetro opcional `assignment=all|mine|unassigned`. O backend filtra `mine` pelos registos `staff.user_id` vinculados **ao ator autenticado** (nunca a um ID arbitrário enviado pelo cliente); `unassigned` seleciona conversas sem colaborador atribuído. Em ambos os caminhos de consulta, incluindo `unreadOnly=true`, os filtros são aplicados **antes** do limite de paginação. São compatíveis com pesquisa, etiquetas, `unreadOnly` e cursor, sob as permissões e RLS existentes.

O Flutter inclui um seletor nas seis línguas pt/en/es/fr/it/de, conserva a opção nas atualizações SSE e repõe a paginação ao mudar de filtro. Mudança de tenant ou revogação limpa a seleção. Os testes verificam isolamento entre operadores, validação de parâmetros, composição com não lidas e comportamento do seletor numa barra lateral de largura limitada.

**CI funcional:** [38074683215](https://github.com/HernanyManuel/Melissa/actions/runs/38074683215), **integralmente verde** (backend com PostgreSQL/RLS/worker, Flutter analyze/test/build web e Compose). [ADR-092](decisions/ADR-092-inbox-assignment-triage-filter.md).

**Limites:** este é um filtro de visualização, não uma regra de autorização nem um comando para modificar a atribuição. A relação staff/utilizador depende de `staff.user_id` no tenant. Sem migração adicional, notificações do sistema, merge, deploy ou WhatsApp live.

## Atualização Phase 8 — Proteção contra recibos atrasados de notas internas

O widget de notas internas impede agora que uma resposta HTTP a um `POST` iniciado numa conversa ou tenant anterior limpe o rascunho, o estado de erro ou o estado de envio da conversa atualmente aberta. O pedido mantém a chave idempotente original, mas o recibo só é aplicado se a geração e os identificadores do tenant/conversa continuarem iguais; ao mudar de contexto, o estado de envio e o conteúdo pendente são repostos exclusivamente no contexto novo. O teste Flutter `late note receipt cannot clear another conversation draft` simula um POST lento, muda de tenant e só depois recebe o resultado anterior.

Esta alteração não cria novos endpoints, não altera o esquema SQL nem envia mensagens ao cliente. O PR continua em draft, sem merge, deploy ou WhatsApp live.

## Atualização Phase 8 — Filtro «Só não lidas» por operador

O inbox permite agora `GET /tenants/:tenantId/conversations?unreadOnly=true`, opcionalmente combinado com `q`, `tagId` e `after`. A seleção dos IDs de conversas que têm eventos `message.received` posteriores ao `last_read_sequence` **do operador autenticado** ocorre no backend e antes do limite de paginação. O SQL é parametrizado, executa-se sob as permissões e RLS do tenant e não recebe `actorId` do cliente. `unreadOnly=false` ou parâmetro omitido conservam o comportamento anterior; valores inválidos são rejeitados.

O Flutter oferece o `FilterChip` «Só não lidas» em seis idiomas, preserva-o em pesquisa, etiquetas, carregamento de outras páginas e atualizações SSE, e repõe a paginação quando o filtro muda. Um recibo válido de «Marcar como lida» remove localmente a conversa da lista filtrada. **Sem migração adicional** e sem qualquer envio externo.

**CI funcional:** [38033475606](https://github.com/HernanyManuel/Melissa/actions/runs/38033475606) integralmente verde (backend PostgreSQL/RLS + worker, Flutter analyze/test/build web, Compose). Testes verificam isolamento por operador, valores inválidos, pesquisas e etiquetas, leitura explícita e 51 conversas lidas antes de uma não lida, impedindo filtros incorretos feitos após paginação. [ADR-091](decisions/ADR-091-actor-unread-only-inbox-filter.md).

**Limites:** as não lidas são eventos recebidos ainda não confirmados, e não a garantia de que o operador nunca os viu. O conjunto pode mudar entre páginas perante leitura/eventos simultâneos. Continuam por implementar preferências de notificação, triagem por atribuição de staff e políticas operacionais de retenção; sem merge/deploy ou WhatsApp live.

## Atualização Phase 8 — Filtragem do inbox por etiqueta

O inbox suporta agora `GET /tenants/:tenantId/conversations?tagId=<uuid>&q=<texto>&after=<uuid>` com filtro por etiqueta aplicado na base de dados, juntamente com a pesquisa e a paginação de 50 conversas. Uma etiqueta tem de existir no tenant autorizado; o cursor também tem de referir uma conversa com essa etiqueta. `GET /tenants/:tenantId/conversation-tags` fornece o catálogo de leitura (até 100 nomes e IDs), com permissão `messages:read`. A relação Prisma utiliza as FKs já existentes da migração 61, sem alteração do schema SQL ou do health check.

O Flutter permite abrir o filtro, escolher uma etiqueta ou regressar a «Todas as etiquetas», mantendo o filtro em pesquisas, carregamento de outras páginas e atualizações SSE. Mudar de etiqueta reinicia a paginação; mudar de tenant ou perder acesso limpa o estado. Testes HTTP verificam catálogo, validação de UUID, etiqueta inexistente, isolamento, composição com pesquisa e remoção do vínculo. Teste Flutter valida seleção, pesquisa, paginação e reposição do filtro.

**CI funcional:** [38030981789](https://github.com/HernanyManuel/Melissa/actions/runs/38030981789) integralmente verde (backend PostgreSQL/RLS e worker, Flutter analyze/test/build web, Compose). [ADR-090](decisions/ADR-090-inbox-tag-filter.md).

**Limites:** só uma etiqueta de cada vez, catálogo até 100 sem paginação; o filtro não confere acesso a conversas de outros tenants nem substitui a gestão de atribuições. Sem merge, deploy ou WhatsApp live.

## Atualização Phase 8 — Etiquetas de conversas por tenant

A migração **61** introduz `conversation_tags` e `conversation_tag_links`, com RLS por tenant, referências compostas para impedir associações entre tenants, criação de etiquetas imutáveis (sem UPDATE/DELETE do catálogo pelo runtime) e associação/remoção idempotente sujeita a `conversations:takeover`. A consulta de etiquetas requer `messages:read`; audit events registam a alteração sem conteúdo de mensagens. Endpoints: `POST /conversation-tags`, `GET /conversations/:id/tags`, `POST/DELETE /conversations/:id/tags/:tagId`.

O Flutter oferece um painel de etiquetas no cabeçalho da conversa para evitar sobrecarga da vista de histórico. A criação, associação e remoção não chamam `/messages` nem criam dispatches. As etiquetas estão localizadas em pt/en/es/fr/it/de. Testes HTTP cobrem isolamento, validação de nomes, repetição, associação, remoção e auditoria; o teste Flutter verifica alterações sucessivas e ausência de envio.

**Validação:** [CI 37998320646](https://github.com/HernanyManuel/Melissa/actions/runs/37998320646) **integralmente verde** (backend com PostgreSQL/RLS e testes de integração, Flutter analyze/test/build web e Compose), após o ajuste do painel de etiquetas e do estado ocupado entre operações. Uma execução anterior encontrou um teste antigo de calendário intermitente; a execução atual passou. [ADR-088](decisions/ADR-088-conversation-tenant-tags.md).

**Limites:** catálogo com até 100 etiquetas listadas, sem paginação, gestão/rename de catálogo ou filtro do inbox por etiqueta. O PR mantém-se draft e não houve merge, deploy, WhatsApp live ou credenciais reais ativadas.

## Atualização Phase 8 — Notas internas imutáveis

A migração **60** cria `conversation_internal_notes`, isolada das mensagens recebidas/enviadas e de todos os despachos de IA e WhatsApp. FKs compostas, RLS por tenant, validação do autor e autorização `messages:read` protegem a leitura e escrita; a role runtime só recebe `SELECT` e `INSERT` limitados, sem `UPDATE` nem `DELETE`. O health check exige `schema_version=60`.

A API expõe `GET/POST /conversations/:id/internal-notes`, com páginas até 50, cursor validado dentro da mesma conversa, texto entre 1 e 2 000 caracteres e UUID por tentativa. Replay com a mesma chave, conversa e texto é idempotente; reutilização com conteúdo diferente devolve 409. O evento de auditoria `conversation.internal_note_created` regista o ID sem o texto. A interface Flutter apresenta notas separadas do histórico de mensagens, sem chamar `/messages` ou acionar qualquer transporte. Após incerteza HTTP, só repete o pedido com a mesma chave e texto. Disponível em seis idiomas.

[ADR-087](decisions/ADR-087-private-conversation-notes.md). Testes cobrem isolamento de tenant e papel `viewer`, idempotência, validação, auditoria, ausência de mensagens de cliente e repetição no Flutter. **CI funcional:** [37967670234](https://github.com/HernanyManuel/Melissa/actions/runs/37967670234) integralmente verde (backend com PostgreSQL/RLS e worker, Flutter analyze/test/build web, Compose).

**Limites:** as notas não têm edição/remoção nem alertas SSE, e a secção exige atualização manual. Qualquer membro com `messages:read` pode consultar notas do tenant; não existem regras por atribuição. Continua por definir a política de retenção/eliminação de notas, cópias de segurança e dados pessoais. Sem merge, deploy ou ativação de WhatsApp live.

## Atualização Phase 8 — Avisos visuais de novas mensagens no inbox

O Flutter mostra agora um aviso transitório no topo da lista e na AppBar quando o contador `unreadCount` de uma conversa **aumenta após atualização REST autorizada** em resposta a um evento SSE. Um evento SSE isolado não basta para notificar, e a primeira listagem não gera avisos retroativos. O indicador conta **conversas com incrementos observados na sessão**, não mensagens totais por ler. Os avisos desaparecem após confirmação de leitura ou após a API indicar `unreadCount=0`; os estados são limpos na mudança de tenant ou revogação de acesso. Traduções disponíveis em pt/en/es/fr/it/de.

**CI funcional:** [37960714885](https://github.com/HernanyManuel/Melissa/actions/runs/37960714885) integralmente verde (backend/integração e worker, Flutter analyze/test/build web, Compose), com teste Flutter de novo aviso confirmado por REST e remoção após «Marcar como lida». [ADR-086](decisions/ADR-086-inbox-verified-in-app-alerts.md).

**Limites:** apenas UI da sessão atual; não há push, notificações do navegador, sons, e-mail ou alertas fora do inbox. Só são contabilizadas conversas carregadas no filtro/páginas visíveis. A funcionalidade não exige migração nova, merge, deploy ou ativação do WhatsApp live.

## Atualização Phase 8 — Inbox com mensagens não lidas por operador

A migração **59** criou `inbox_read_cursors` com isolamento RLS por **tenant e ator**, e o health check exige `schema_version=59`. A listagem de conversas calcula `unreadCount` e `unreadUpTo` apenas com eventos duráveis `message.received`, sem examinar o conteúdo das mensagens. O `POST /conversations/:id/read` exige permissão `messages:read`, aceita `{upTo: "42"}`, valida que o número é um evento de entrada na mesma conversa e avança o cursor idempotente/monotonicamente; qualquer mensagem posterior permanece não lida. O avanço publica um evento SSE `conversation.read` (sem texto/ator no payload) para atualização de outros separadores.

O Flutter mostra badges nas conversas com mensagens não lidas e disponibiliza «Marcar como lida» **explicitamente** após carregar o histórico, nunca automaticamente ao abrir uma página de mensagens que pode estar incompleta. Testes HTTP/RLS validam o isolamento entre operadores e tenants, exclusão de eventos de saída, rejeição de cursores inválidos, replay idempotente e novas entradas; teste Flutter cobre badge e ação de leitura.

**CI funcional:** [37953921259](https://github.com/HernanyManuel/Melissa/actions/runs/37953921259) **integralmente verde** (backend com PostgreSQL/worker, Flutter analyze/test/build web, Compose). [ADR-085](decisions/ADR-085-operator-scoped-unread-inbox.md).

**Limites:** contagem de eventos recebidos ainda por confirmar pelo operador, não garantia de visualização ou tratamento; abrir histórico paginado não marca automaticamente. Sem notificações browser/push/sonoras, preferências de alertas, notas/tags ou painel completo de cliente. Sem ativar WhatsApp live, merge, deploy ou E2E Meta real. Permanecem as restrições de retenção de ADR-084.

## Atualização Phase 8 — Expurgo do texto de preparações humanas

A migração **58** introduz `human_outbound_intents.redacted_at`, um marcador de expurgo `[redacted]` e uma trigger PostgreSQL que rejeita alterações arbitrárias de texto, reversão de expurgo ou expurgo de qualquer intenção com dispatch. Ao **abandonar** uma preparação, o backend substitui o texto e guarda a data de expurgo na mesma transação, mantendo o identificador e metadados para impedir reenvio. O `GET /manual-replies/latest` devolve `text:null` para intenções expurgadas; o Flutter mostra o estado terminal sem revelar texto nem permitir envio automático.

A rotina administrativa `pnpm --filter @melissa/backend privacy:redact-manual-preparations` faz simulação por defeito, com contagens sem texto; só o argumento `--apply` expurga até **500** preparações elegíveis por execução, usando `MIGRATION_DATABASE_URL`, bloqueios `FOR UPDATE SKIP LOCKED` e exclusão de dispatch existente. A migração trata também as preparações já expiradas/abandonadas na data de aplicação. Ver [ADR-084 e procedimento operacional](decisions/ADR-084-human-reply-content-redaction.md).

**CI funcional:** [37942049114](https://github.com/HernanyManuel/Melissa/actions/runs/37942049114) integralmente verde (backend PostgreSQL/RLS/worker, Flutter analyze/test/build web, Compose) no commit `80b933132ca38efa2f87b3100b961026dbce2754`. Os testes abrangem expurgo no abandono, expiração em lote, ausência de despacho, `text:null`, e trigger recusando expurgo de uma resposta antiga com dispatch.

**Limites:** o comando de expurgo de expirados **não é automático**; requer operação controlada. A linha ativa já não guarda o texto após expurgo, mas versões MVCC, WAL, backups, logs e sistemas externos podem manter cópias; não se declara eliminação forense. Intenções despachadas e clientes legados com POST direto mantêm a sua retenção/semântica atuais. Continuam pendentes política de backups, notificações, unread, notas/tags, painel completo do cliente e E2E Meta real. Sem merge/deploy nem ativação de worker live.

## Atualização Phase 8 — Expiração e abandono de preparações humanas

Uma resposta preparada no servidor, mas ainda **sem registo de despacho**, tem agora validade de **24 horas** desde `created_at`: `GET /manual-replies/latest` e replay de `POST /manual-replies/prepare` devolvem `expired` após o prazo, e qualquer confirmação `POST /messages` dessa preparação é recusada com 409. O novo `POST /manual-replies/abandon` aceita `{requestId}`, é idempotente e opera apenas sobre intenções do operador autenticado e do tenant/conversa autorizados. Não pode abandonar nem cancelar mensagens que já possuam dispatch. A migração **57** introduz `abandoned_at`, concedendo à role runtime UPDATE apenas sobre essa coluna, e o health check passa a validar a versão 57.

O Flutter apresenta `prepared/expired/abandoned`, disponibiliza «Abandonar preparação» apenas no estado preparado e permite iniciar uma nova resposta após abandono ou expiração, sem envio automático. Ver [ADR-083](decisions/ADR-083-prepared-human-reply-expiry-and-abandonment.md). O workflow funcional [37916802403](https://github.com/HernanyManuel/Melissa/actions/runs/37916802403) **passou integralmente** no commit `7fda06b28b0078b7f1a49d8384bbd3063625e3cf`: backend com migrations/RLS e integração, Flutter analyze/test/build web, Docker Compose.

**Limites:** a expiração é calculada em leitura/confirmação, não por tarefa agendada; uma página aberta pode mostrar estado antigo até refresh, mas o servidor impede confirmação fora do prazo. Abandonar ou expirar não elimina fisicamente texto sensível: retenção/purga segura continua pendente. Clientes legados com POST direto mantêm o comportamento de envio imediato; o worker WhatsApp live continua desativado por defeito. Não houve merge/deploy, nem E2E Meta real. Outras prioridades: notificações, unread, notas/tags, painel de cliente e gate P7 Google Calendar.

## Atualização Phase 8 — Preparação durável antes da confirmação humana

O Flutter passou a preparar respostas humanas através do novo `POST /api/v1/tenants/:tenantId/conversations/:id/manual-replies/prepare`: o backend guarda `requestId` e texto no `human_outbound_intents` sob RLS/permissão `conversations:reply`, **sem criar dispatch e sem possibilidade de o worker enviar esse registo**. Uma confirmação explícita por `POST /conversations/:id/messages` reutiliza o mesmo par idempotente, revalida modo `HUMAN_ACTIVE`, atribuição, canal WhatsApp live e `mode_epoch`, e só então cria o despacho. O GET de reconciliação passa a reconhecer `state: prepared` e o Flutter mostra a preparação recuperada após reload, sem enviar automaticamente. Ver [ADR-082](decisions/ADR-082-durable-manual-reply-preparation.md).

O workflow [37899957749](https://github.com/HernanyManuel/Melissa/actions/runs/37899957749) passou integralmente no commit funcional `49d292258c509886cd8bf6c70df26fb4266eb1bc`: backend/integração PostgreSQL/RLS, Compose, Flutter analyze/test/build web. Testes cobrem ausência de dispatch após preparação, repetição idempotente, promoção explícita, rejeição após reativação da IA e recuperação de uma preparação após reload.

**Limitações:** clientes legados que chamam diretamente `POST /messages` ainda não beneficiam da preparação prévia; preparações nunca confirmadas requerem política de retenção/abandono; o GET consulta apenas a última intenção do ator. A segurança de reload aplica-se ao novo percurso Flutter, não a todas as formas de envio. Faltam notificações, unread, notas/tags, painel completo do cliente e E2E Meta real. Não houve merge/deploy nem ativação dos workers live; o gate P7 Google Calendar continua aberto.

## Atualização Phase 8 — Recuperação de resposta manual persistida após reload

A UI Flutter reconcilia agora a última resposta manual **do operador autenticado** através de `GET /api/v1/tenants/:tenantId/conversations/:id/manual-replies/latest`. O endpoint read-only usa scope de tenant, permissão `conversations:reply` e filtro por ator, devolvendo `{item:null}` ou a intenção original (`intentId`, `requestId`, texto, estado e data). Um dispatch ausente e inconsistente gera erro 503. O Flutter recupera `pending/accepted/rejected/failed` após reload **sem reenviar automaticamente** e consulta este endpoint quando um POST termina com resultado incerto. Se a consulta inicial falhar, bloqueia novas respostas até conseguir verificar. O retry ainda em memória conserva a chave e texto exatos. Ver [ADR-081](decisions/ADR-081-manual-reply-reconciliation-after-reload.md).

O workflow [37897525313](https://github.com/HernanyManuel/Melissa/actions/runs/37897525313) passou integralmente no commit funcional `b10ec6dc598ebfbfea73b11f35a73c969693743e`: backend com migrations, formatter, lint, typecheck, testes unitários e integração HTTP/PostgreSQL/RLS, worker/Redis recovery, OpenAPI, Compose e Flutter analyze/test/build web. Os novos testes cobrem ausência e recuperação do registo, isolamento cross-tenant e entre atores, bloqueio de colaborador não atribuído (403), atualização do estado do dispatch, reload sem novo POST e 503 reconciliado em GET.

**Limite essencial:** só se consegue restaurar uma resposta já persistida. Um GET vazio **não** prova que um POST incerto em trânsito nunca será guardado; se o reload perdeu uma chave ainda não persistida, o operador deve verificar manualmente antes de qualquer nova tentativa. Não se guarda texto no storage do navegador, nem se confunde aceitação pelo provider com entrega. Restam recuperação segura da chave ainda não persistida, notificações, unread count, notas/tags, painel completo de cliente, E2E WhatsApp live e gate P7 Google Calendar real. Não houve merge/deploy.

## Atualização Phase 8 — Inbox Flutter com SSE/replay e refresh REST

A UI de conversas subscreve agora `GET /api/v1/tenants/:tenantId/inbox/events` através de um stream SSE autenticado, validando eventos mínimos e sequência monotónica por tenant. Na reconexão envia o último cursor via `Last-Event-ID`/`after`, ignora replay duplicado e aplica backoff. Mudança de tenant ou revogação de acesso cancela a subscrição e descarta o estado sensível.

Cada evento força uma nova leitura REST autorizada: a lista e o histórico da conversa selecionada atualizam sem trocar a seleção. Eventos são agrupados, refreshes REST serializados por tenant e a lista de IDs afetados é preservada para retry após falhas temporárias. Um teste específico prova que a chegada de dois eventos durante uma consulta REST lenta não perde a segunda atualização. Ver [ADR-080](decisions/ADR-080-flutter-inbox-sse-replay.md).

O workflow [37849570752](https://github.com/HernanyManuel/Melissa/actions/runs/37849570752) passou integralmente no commit funcional `84fca5867ca0034db9a6fd7bbfb643b444052b3e`: Flutter analyze/test/build web, backend e Docker Compose. O workflow [37846050931](https://github.com/HernanyManuel/Melissa/actions/runs/37846050931) já tinha validado os testes de parser, cursor, autenticação, replay, reconexão, atualização e troca de tenant.

Continuam por implementar: persistência de cursor entre sessões, reconciliação/recuperação da chave de retry de resposta manual após reload, notificações, unread count, notas/tags, painel de cliente completo e E2E real. As leituras de histórico já paginado estão limitadas à profundidade carregada (máximo de 10 páginas nesta fatia), sem snapshot transacional global. Não houve validação com provider WhatsApp live, merge ou deploy; o gate externo P7 para credenciais reais Google Calendar continua aberto.

## Atualização Phase 8 — Primeira fatia de UI Flutter para controlo humano

A interface de conversas inclui agora `ConversationHumanControls`, com indicação do modo, seleção de colaborador ativo, takeover, reativação da IA e fecho. Para conversas `HUMAN_ACTIVE` atribuídas e em canal WhatsApp live, há composer ligado a `POST /api/v1/tenants/:tenantId/conversations/:id/messages`; respostas incertas podem ser repetidas explicitamente com o mesmo `requestId` e o mesmo texto, sem criar uma nova intenção. Um resultado `pending` representa fila durável, `accepted` apenas aceitação pelo provider, nunca entrega. Ver [ADR-079](decisions/ADR-079-incremental-flutter-inbox-controls.md).

O workflow [37844039975](https://github.com/HernanyManuel/Melissa/actions/runs/37844039975) ficou integralmente verde no commit `e1327e8c43b234db270241b8aee1c7495a91a9d3`: Flutter gen-l10n/analyze/test/build web, backend migrations/unitários/integração/recovery/OpenAPI/audit e Compose. Novos testes Flutter provam takeover, retry com chave/payload estáveis, fecho, bloqueio de composer em canal mock e descarte de resposta HTTP tardia após mudar de conversa. O falhanço Calendar observado no workflow documental anterior não se repetiu.

A UI continua parcial: falta consumo SSE/reconnect na UI, painel de cliente, notificações, notas/tags, unread count, E2E e recuperação do requestId após navegação/reload. A chave de retry permanece apenas em memória no widget; não se deve reenviar com chave nova após um resultado incerto sem consultar o histórico/estado. Não foi validado WhatsApp live com credenciais reais, nem feito merge/deploy; o gate P7/Google Calendar real continua aberto.

## Atualização Phase 8 — Resposta manual durável e fenced (schema 56)

A terceira fatia do PR #7 implementa o backend de resposta humana por `POST /api/v1/tenants/:tenantId/conversations/:id/messages`. A permissão `conversations:reply` é permitida a owner/admin/manager/staff, não a viewer. O envio exige `HUMAN_ACTIVE` e atribuição válida; staff só responde pela própria identidade. O `requestId` é idempotente por tenant/ator e o HTTP 200 confirma apenas persistência da intenção, nunca a entrega. Ver [ADR-078](decisions/ADR-078-durable-fenced-human-replies.md).

O schema 56 adiciona `human_outbound_intents`, `human_outbound_dispatch` e `human_outbound_dead_letters`, com RLS/grants mínimos. O dispatcher revalida modo, `mode_epoch`, atribuição e canal WhatsApp live antes de chamar o provider: reativar a IA torna obsoletas as intenções humanas anteriores. Após aceitação do provider, o backend guarda a mensagem outbound de staff e publica `message.sent` no Inbox. O worker está desligado por omissão (`HUMAN_OUTBOUND_WORKER_ENABLED=false`) e não usa fallback mock silencioso.

O workflow [37842750417](https://github.com/HernanyManuel/Melissa/actions/runs/37842750417) ficou integralmente verde no commit `925f56f17066c08157ffe1d9e625ff02c5cf0eb4`. Foram validados migration/readiness schema 56, formatter, lint, typecheck, unitários, integração PostgreSQL/RLS da resposta manual (incluindo idempotência e fencing), worker real/recovery Redis, OpenAPI, audit de dependências, Compose e Flutter. O bloqueio de grant Prisma para `created_at` e campos de inicialização do dispatch foi corrigido com privilégios de coluna restritos.

P8 continua incompleto: faltam UI Flutter do Inbox e composer humano, consumo SSE na UI, notificações, notas/tags e E2E. Não houve validação WhatsApp live com credenciais reais nem merge/deploy. O gate externo P7/Google Calendar continua aberto.

## Atualização Phase 8 — Controlo humano + eventos real-time duráveis (schema 55)

A fundação do Inbox no PR #7 inclui agora controlo humano e um feed SSE durável tenant-scoped. Schema 54 introduziu `assigned_staff_id`, `closed_at`, a permissão `conversations:takeover` e os comandos autenticados de takeover, reativação da IA e fecho. Takeover preserva o grafo `AI_ACTIVE -> WAITING_HUMAN -> HUMAN_ACTIVE`; cada mudança real de modo avança `mode_epoch`, e o dispatcher volta a verificar modo/epoch antes de qualquer envio automático. Ver [ADR-076](decisions/ADR-076-human-conversation-control.md).

Schema 55 introduz `inbox_events`: log mínimo e durável com sequência monotónica por tenant. O endpoint autenticado `GET /api/v1/tenants/:tenantId/inbox/events` usa SSE, aceita cursor inicial `after` e recupera eventos perdidos através do header padrão `Last-Event-ID`. O payload real-time contém apenas tipo, conversation/message IDs e timestamp; conteúdo continua atrás dos endpoints REST existentes. Mensagens inbound, handoff da IA, takeover, reativação e fecho escrevem o evento na mesma transação da mutação original. Ver [ADR-077](decisions/ADR-077-durable-inbox-event-stream.md).

A integração com PostgreSQL/RLS e worker real prova replay após reconexão, isolamento cross-tenant, validação de cursor, evento de mensagem inbound e ausência de duplicação em replay de handoff. O workflow `37700844071` ficou integralmente verde no commit `fe7e327365f680006e699db9b179b7bc90ef660d`: migrations/schema 55, formatter, lint, typecheck, unitários, integração completa, restart/Redis recovery, OpenAPI, audit de dependências de produção, Compose e Flutter.

P8 continua em progresso: a resposta manual de staff já foi implementada na fatia seguinte (schema 56, descrita acima), mas faltam notificações, notas/tags e UI Inbox completa. O gate externo de P7 para Google Calendar com credenciais reais continua aberto.

## Atualização Phase 5/P7 — Rotação da chave persistente de credenciais Calendar (schema 53)

A chave de encriptação persistente das credenciais Google Calendar tem agora keyring versionado: uma chave atual de escrita e chaves anteriores temporárias de leitura. Credenciais sob uma chave antiga são re-encriptadas para a chave atual durante a leitura; um sweep operacional cobre credenciais inativas através de descoberta mínima `SECURITY DEFINER`, voltando ao scope RLS do tenant para a leitura/re-encriptação real. O comando `calendar:rotate-credential-key` falha fechado quando uma chave antiga está indisponível ou a migração não converge, e o runbook preserva as chaves antigas até o sweep concluir e documenta rollback. Ver [rotação da chave Calendar](calendar-credential-key-rotation.md).

Testes unitários cobrem sweep, bloqueio e não convergência; integração PostgreSQL prova re-encriptação old→current e leitura posterior com keyring apenas da chave atual. O workflow `37397283308` ficou integralmente verde no commit `3205b0d311b5ccb3387dbfda6d0e34667793c874`: backend, Docker Compose e Flutter, incluindo formatter, lint, typecheck, unitários, worker real/recovery, OpenAPI e audit de dependências de produção. Isto não equivale a rotação executada em staging/produção nem a validação live com uma conta Google real; runtimes live continuam desativados por omissão.

## Atualização Phase 5 — Outbox automática (schema 23)

Resposta live, conclusão do turno, usage e envelope de dispatch são persistidos atomicamente após fence final sob lock. Takeover concorrente produz `stale` sem outbound; conteúdo fica numa tabela tenant-scoped imutável e o índice global não o expõe. Ver [ADR-062](decisions/ADR-062-ai-automatic-outbox.md). Ainda sem consumer, adapter live, retries/recibos ou deploy.

## Atualização Phase 5 — Coordenador de turno

`ConversationTurnCoordinator` liga contexto, tools, engine, fencing e ledger com replay seguro e códigos de falha sanitizados. Uso consumido antes de fencing obsoleto é preservado; texto só é devolvido após finalização durável e erro de DB propaga para retry. Ver [ADR-061](decisions/ADR-061-conversation-turn-coordinator.md). Ainda sem queue/worker, outbox automática, handoff persistido ou deploy.

## Atualização Phase 5 — Ledger de turnos e usage (schema 22)

`ai_turns` fixa tenant/conversation/customer e versões de fencing; `ai_usage_events` regista uma única medição append-only por turno. Início idempotente, replay com scope exato, transição terminal e usage são protegidos transacionalmente; prompts/respostas não são persistidos. Ver [ADR-060](decisions/ADR-060-exactly-once-ai-turn-ledger.md). Ainda sem wiring ao worker, pricing/custo, reconciliação, outbound ou deploy.

## Atualização Phase 5 — AIProvider e AIGateway

Contrato vendor-neutral sem DB/rede, gateway com limites de contexto/output, tools allowlisted, JSON defensivo e erros sanitizados. Tenant/correlation não chegam ao provider; MockAIProvider determinístico permite testes. Ver [ADR-053](decisions/ADR-053-ai-provider-gateway-boundary.md) e [motor de IA](ai-engine.md). Sem adapter real, tool executor, persistência, integração com conversas, merge ou deploy.

## Atualização Phase 4 — Gate de malware ClamAV

MalwareScanner/ClamAV INSTREAM analisa bytes validados antes do storage. Apenas `OK` permite escrita; `FOUND`, timeout, erro ou resposta desconhecida falham fechados. Worker exige scanner completo, com limites de corpo/resposta/tempo; testes cobrem protocolo, deteção, indisponibilidade, configuração e ausência de escrita. Ver [ADR-052](decisions/ADR-052-clamav-malware-gate.md). Base real/updates/health/network policy ainda não validados; sem merge/deploy.

## Atualização Phase 4 — Assinaturas binárias de media

MediaIngestor confirma magic bytes de JPEG, PNG, PDF, OGG, MP3 e MP4 antes do storage, além da correspondência MIME/checksum/tamanho existente. Payload spoofed ou demasiado curto falha sem escrita; testes cobrem todas as assinaturas permitidas e divergência. Ver [ADR-051](decisions/ADR-051-media-binary-signatures.md). Parsing completo, polyglots e malware scanning continuam pendentes; sem merge/deploy.

## Atualização Phase 4 — Worker opt-in de ingestão media

Dispatcher PostgreSQL/BullMQ publica apenas UUID interno e tentativa; processador revalida tenant/payload. Arranque exige flag explícita, transporte Meta, S3 e keyring completos, sem fallback mock. Concorrência 2, lote 25, retries duráveis e shutdown ordenado; teste integrado usa Redis/PostgreSQL reais sem rede externa. Ver [ADR-050](decisions/ADR-050-opt-in-media-ingestion-worker.md). Nenhuma chamada Meta/S3 real, merge ou deploy.

## Atualização Phase 4 — Storage persistente S3-compatible

Adapter privado com SigV4, HTTPS estrito, credenciais temporárias opcionais, escrita condicional sem overwrite e GET limitado com verificação de tamanho/checksum. Factory fail-closed e configuração server-side explícita; sem fallback mock ou URL pública. Ver [ADR-049](decisions/ADR-049-s3-storage-provider.md). Ainda sem validação cloud real, bucket policy, lifecycle, ativação do worker, merge ou deploy.

## Atualização Phase 4 — Rotação de chaves de quarentena

Keyring fail-closed mantém uma chave atual de escrita e até quatro anteriores apenas para leitura. Valida base64 canónico de 32 bytes, IDs/material únicos, configuração completa e cópias defensivas; o webhook nunca cifra com chave anterior. Ver [ADR-048](decisions/ADR-048-quarantine-key-rotation.md). Sem secret manager, rotação automática, ativação do consumidor, merge ou deploy.

## Atualização Phase 4 — Ciclo transacional de ingestão media (schema 20)

Processador resolve tenant sem confiar na fila, autentica AES-256-GCM/AAD, valida a referência e usa o MediaIngestor idempotente. Tentativas, backoff e resultado mínimo ficam duráveis; conclusão e auditoria são serializadas e falhas não expõem detalhes do provider. Ver [ADR-047](decisions/ADR-047-media-ingestion-lifecycle.md). O worker continua desligado enquanto não existir StorageProvider persistente e rotação de chaves; sem downloads reais, merge ou deploy.

## Atualização Phase 4 — Envelope durável de media (schema 19)

Novos eventos media em quarentena criam envelope mínimo na mesma transação, sem ID externo/MIME/URL/telefone/payload; duplicação não repete e purga da quarentena remove por cascade. RLS, grants imutáveis, readiness e testes. Sem backfill ou consumidor. Ver [ADR-046](decisions/ADR-046-durable-media-ingestion-envelope.md). Nenhum download/storage real; sem merge/deploy.

## Atualização Phase 4 — Configuração media WhatsApp

Flag opt-in e campos separados para token, versão e hosts exatos; configuração incompleta/unsafe falha no arranque. Factory retorna null desligada e nunca cai para mock. `.env.example`, testes e docs atualizados. Ver [ADR-045](decisions/ADR-045-whatsapp-media-configuration.md). Adapter ainda não registado nem ligado a webhook/worker/DB; sem credenciais ou chamadas reais. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Adaptador HTTP de media WhatsApp

WhatsAppGraphMediaSource desligado por defeito: metadata em origem Graph fixa, Bearer server-side, versão explícita, allowlist exata de hosts, HTTPS/redirect/porta, timeout e streaming limitado. Erros sanitizados e testes fetch injetado. Ver [ADR-044](decisions/ADR-044-whatsapp-media-http-adapter.md). Sem defaults de hosts, credenciais, wiring, chamadas reais ou validação com conta Meta; ativação bloqueada. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Núcleo de ingestão de media

MediaSourceProvider e MediaIngestor com IDs opacos, allowlist MIME, correspondência do tipo declarado, limite de 10 MiB, SHA-256 opcional e chave tenant opaca. Mock sem rede e testes de replay/validação/falhas. Ver [ADR-043](decisions/ADR-043-safe-media-ingestion-core.md). Não ligado ao webhook/DB; sem download Meta, magic bytes, malware scan, reconciliação ou limpeza. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — StorageProvider para media

Contrato binário vendor-neutral e MockStorageProvider privado, limitado, idempotente e com cópias defensivas. Testes de concorrência, conflito, capacidade, chaves/tipos e delete. Ver [ADR-042](decisions/ADR-042-storage-provider-foundation.md). Ainda não descarrega media Meta, não liga DB/quarentena e não configura storage de produção; estes controlos são pré-requisitos do próximo incremento. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Polling outbound limitado

Após `pending`, Flutter consulta por GET uma vez/segundo até estado terminal ou 15 tentativas; nunca repete POST. Cancela em troca de contexto/fecho/nova intenção e mantém consulta manual. 429 respeita Retry-After. Ver [ADR-041](decisions/ADR-041-bounded-outbound-polling.md). Sem WebSocket, recovery após reload, requeue operacional ou envio real. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Estado outbound na API/UI

POST/GET expõem estado mínimo `pending`, `mock_accepted`, `rejected` ou `failed`; intenções históricas sem fila ficam `stored`. Sem payload, destinatário, tentativas ou erro. Flutter distingue estados em seis idiomas e consulta sem reenvio. Ver [ADR-040](decisions/ADR-040-outbound-processing-status.md). Retry operacional, polling e envio real pendentes. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Fila outbound mock

Schema 18 e envelope atómico para novas intenções; worker BullMQ com descoberta PostgreSQL, replay seguro e cinco falhas registadas antes de estado terminal. Testes de worker separado, recuperação do resultado persistido, retries e isolamento. Ver [ADR-039](decisions/ADR-039-outbound-mock-queue.md). Intenções antigas não são ativadas; API/UI continuam a indicar apenas armazenamento. Resultado visual, operação de falhas, retenção e envio real pendentes. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Processamento interno outbound mock

Schema 17: resultado imutável por intenção, RLS e auditoria transacional. Processador interno revalida permissões/canal/cliente/conversa e retorna o mesmo resultado em replay. Testes de concorrência, revogação, rollback e isolamento. Ver [ADR-037](decisions/ADR-037-outbound-mock-processing.md). Ainda sem dispatcher, ligação às filas ou resultado na API/UI; nenhum envio real. Validação integral nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Interface outbound de sandbox

Página a partir de conversas mock, com verificação de acesso/canal, armazenamento e consulta de recibo. Texto/UUID preservados em memória para retry; espera Retry-After e bloqueio após erros definitivos. Seis idiomas e testes widget de replay/consulta/limite/troca de tenant. Ver [ADR-036](decisions/ADR-036-outbound-sandbox-ui.md). Não envia mensagens nem altera histórico; recuperação após reload e dispatch pendentes. CI nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Rate limit outbound

Contadores Redis atómicos por utilizador: 30 gravações e 120 consultas por janela de 60s. 429 com Retry-After; falha do limiter devolve 503 antes de guardar intenção. Testes de concorrência, TTL, bloqueio, consulta independente e replay; OpenAPI atualizado. Ver [ADR-035](decisions/ADR-035-outbound-rate-limit.md). Sem envio real/UI; CI nos checks do PR #5, schema 16 mantido, sem merge/deploy.

## Atualização — Tooling de auditoria

pnpm 11.25.0 alinhado em projeto/CI/Docker para usar Bulk Advisory, com allowBuilds explícito e verificação da versão efetiva. Node 22 e dependências da aplicação preservados. Auditoria continua obrigatória, sem ignorar erros externos. Ver [ADR-034](decisions/ADR-034-pnpm-bulk-audit.md); resultado integral nos checks do PR #5. Sem merge/deploy.

## Atualização Phase 4 — API de intenções outbound

POST de sandbox para guardar intenção e GET de recibo mínimo, restritos a owner/admin. HTTP 200 significa `stored`, não queued/sent. OpenAPI explícito e testes HTTP de autenticação, RBAC, isolamento, concorrência, conflito e respostas sem conteúdo. Ver [ADR-033](decisions/ADR-033-outbound-sandbox-api.md). Sem UI, consumidor ou envio; schema 16. Rate limiting específico e retenção continuam pendentes. CI nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Aceitação interna outbound

Serviço de sandbox owner/admin com validação de conversa/cliente/canal mock, intenção e auditoria atómicas, replay idempotente e conflitos auditados. Limite temporário de 1000 intenções/tenant; resposta `stored` sem alegar envio. Testes PostgreSQL de concorrência, RBAC, quota e rollback. Ver [ADR-032](decisions/ADR-032-outbound-intent-acceptance.md). Sem API, UI, fila ou chamada ao provider; schema 16 mantido. CI nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Intenções outbound duráveis (schema 16)

Tabela imutável `outbound_intents`, RLS forçada, FKs compostas e chave idempotente por tenant/ator. Só provider mock; sem API/consumidor ou envio. Testes de persistência, rollback, isolamento, grants e concorrência. Ver [ADR-031](decisions/ADR-031-durable-outbound-intents.md). Autorização de envio, auditoria/replay, dispatch/worker, retenção e UI continuam pendentes. Readiness exige schema 16; validação integral nos checks do PR #5. Sem merge/deploy.

## Atualização Phase 4 — MessagingProvider outbound

Contrato de envio de texto, registo fail-closed e MockMessagingProvider idempotente em processo. Testes de concorrência/conflito e bloqueio de live/desligado/tipo desconhecido. Ver [ADR-030](decisions/ADR-030-messaging-provider-abstraction.md). Fundação ainda não ligada a API/outbox/worker; nenhuma mensagem é enviada. Durabilidade, adapter Meta e UI continuam pendentes. CI nos checks do PR #5; sem migration, merge ou deploy.

## Atualização Phase 4 — Pesquisa de conversas

API/Flutter pesquisam por nome do cliente ou canal, sem pesquisar conteúdo. Query limitada/escapada, paginação preservada, seis idiomas, limpar e proteção contra respostas atrasadas. Testes HTTP/UI e isolamento adicionados. Ver [ADR-029](decisions/ADR-029-conversation-name-search.md). Carga/índices para pesquisa em grande escala continuam pendentes. CI nos checks do PR #5; sem migration, merge ou deploy.

## Atualização Phase 4 — Índice de processamento (schema 15)

Índice por tenant/estado/id para a vista operacional, preservando o índice de dispatch global. Migration com timeouts limitados, readiness atualizado e teste de catálogo/estrutura. Ver [ADR-028](decisions/ADR-028-processing-tenant-index.md). Não constitui benchmark; carga representativa e rollout live concorrente continuam pendentes. CI nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Vista de processamento

API e Flutter owner/admin para mensagens pending/failed/rejected, com paginação e metadados mínimos. Sem conteúdo, reenvio ou cancelamento. Seis idiomas, OpenAPI e testes HTTP/RBAC/isolamento/UI. Ver [ADR-027](decisions/ADR-027-processing-operations.md). Escala/índice adicional e painel admin global continuam pendentes. CI nos checks do PR #5; sem migration, merge ou deploy.

## Atualização Phase 4 — Integridade dos recibos

Corrigida inferência indevida de processed quando faltava dispatch. Apenas eventos inbound mock/whatsapp possuem recibo; quarentena/callbacks devolvem 404 e evidência incompleta devolve 503 sanitizado. Testes de invariantes, HTTP/isolamento e recuperação de consulta Flutter adicionados. Ver [ADR-026](decisions/ADR-026-receipt-integrity.md). Sem mudança de schema, merge ou deploy; validação nos checks do PR #5.

## Atualização Phase 4 — Simulação inbound no Flutter

Canal mock ativo permite selecionar cliente, enviar texto pela outbox/fila e consultar recibo. Repetição em caso de rede reutiliza UUID/payload em memória; 202 não é apresentado como processamento concluído. Seis idiomas, clientes paginados, testes de replay/consulta/modo live/isolamento visual. Ver [ADR-025](decisions/ADR-025-inbound-simulation-ui.md). Não envia WhatsApp, não executa IA nem garante idempotência após reload. CI nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Página de canais

Flutter permite listar/criar canais mock e desligá-los com confirmação, através das APIs existentes. Acesso owner/admin, seis idiomas, estados de UI e proteção contra respostas tardias/duplicação por repetição automática. Canais live apenas de consulta. Ver [ADR-024](decisions/ADR-024-channel-management-ui.md). Testes novos de interface; CI nos checks do PR #5. Simulação de mensagens pela UI e provisioning Meta permanecem pendentes. Sem merge/deploy.

## Atualização Phase 5 — ConversationEngine limitado

Adicionado loop neutral de até quatro rondas/oito tools, resultados tipados, execução sequencial, usage acumulado e `handoff_required` ao atingir limites. `ConversationFence` revalida associação tenant/conversation/customer, `AI_ACTIVE` e `mode_epoch` antes/depois do provider, antes de cada tool e antes do resultado final. O adapter OpenAI suporta pares `function_call`/`function_call_output`. Ver [ADR-059](decisions/ADR-059-bounded-conversation-engine-loop.md). Ainda sem worker, persistência do turno, cost guard, auditoria, outbound ou mudança real para handoff. Validação local/CI pendentes; sem merge/deploy.

## Atualização Phase 5 — Estado versionado e fencing

Schema 21 adiciona `mode_epoch`, `state_version`, estado V1 e trigger DB que impede alterações não versionadas. `ConversationStateService` valida shape/transições e faz compare-and-swap por tenant/conversation/customer, `AI_ACTIVE`, epoch e versão; workers antigos falham sem commit. Contadores BigInt internos são removidos da API pública. Ver [ADR-058](decisions/ADR-058-conversation-state-fencing.md). Ainda sem endpoints de takeover, auditoria, loop IA ou outbound automático. Validação local/CI pendentes; sem merge/deploy.

## Atualização Phase 5 — AIContextBuilder mínimo

Adicionados `AIContextBuilder` e `PrismaAIContextSource`: associação tenant/conversation/customer validada sob RLS, política de sistema estática, referência JSON marcada como não confiável, campos públicos mínimos, até 12 mensagens e orçamentos determinísticos. Contactos/notas/consentimentos/credenciais/metadata são excluídos; live exige conversa `AI_ACTIVE`. Ver [ADR-057](decisions/ADR-057-minimal-untrusted-ai-context.md). Ainda não há state version, resumo, metering, loop de tools ou ligação ao worker; sem ativação real. Validação local e CI pendentes; sem merge/deploy.

## Atualização Phase 5 — Tools read-only de negócio

Implementadas seis tools server-owned (`get_business_info`, `get_services`, `get_service_details`, `get_price`, `get_business_hours`, `get_staff`) com schemas fechados, validators semânticos, capabilities e porta `BusinessToolReader`. O adapter Prisma usa transação curta, `app.tenant_id`, filtros tenant explícitos, campos públicos mínimos e strings decimais. Testes impedem injeção de tenant, UUID/data inválidos e acesso sem capability. Ver [ADR-056](decisions/ADR-056-tenant-scoped-business-read-tools.md). Ainda não ligadas ao worker/loop; sem tráfego, escrita ou ativação real. Validação local e CI pendentes; sem merge/deploy.

## Atualização Phase 5 — Registry e executor seguro de tools

Adicionados `ToolRegistry` e `ToolExecutor` controlados pelo backend: schemas e handlers server-side, capabilities obrigatórias, contexto tenant/customer/conversation injetado, idempotency key derivada do turno, validação semântica, outputs JSON limitados, até oito calls sequenciais, timeout e erros sanitizados. Registos de escrita/handoff sem suporte declarado a idempotência são recusados. Ver [ADR-055](decisions/ADR-055-server-owned-tool-registry.md). Ainda não existem handlers reais, loop conversacional, persistência, auditoria ou metering; a IA continua sem acesso a dados/efeitos reais. Validação local e CI pendentes; sem merge/deploy.

## Atualização Phase 5 — Adapter OpenAI Responses

Adicionado adapter real, mas opt-in, atrás de `AIProvider`/`AIGateway`: endpoint fixo, chave e modelo explícitos server-side, timeout, resposta limitada, `store: false`, schemas de tools estritos e parsing fechado de texto/tool calls. Seleção `disabled|mock|openai` sem fallback silencioso e testes de contrato sem rede. Ver [ADR-054](decisions/ADR-054-openai-responses-adapter.md). Não foram usadas credenciais nem feitas chamadas reais; executor de tools, estado, metering, integração com conversas e UI continuam pendentes. Validação local e CI do commit desta alteração ainda pendentes; sem merge/deploy.

## Atualização Phase 4 — Contrato OpenAPI de quarentena

DTOs explícitos, operationId estável, cursor, campos obrigatórios, datas, avisos, erros e cabeçalhos documentados. Testes verificam o esquema gerado e os cabeçalhos/validação HTTP. Ver [ADR-023](decisions/ADR-023-quarantine-openapi-contract.md). Sem alteração do formato HTTP ou UI; geração de cliente Dart e contratos restantes não concluídos. Validação integral nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Recuperação do transporte Redis

Teste do worker inclui corte real dos seus sockets Redis via proxy loopback, readiness 503/liveness 200, backlog preservado no PostgreSQL e retoma no mesmo processo após reconexão. Replay/auditoria/payload verificados. Ver [ADR-022](decisions/ADR-022-redis-transport-recovery.md). A API mantém a sua ligação; falha global/restart do servidor Redis e interrupção durante processamento continuam pendentes. CI nos checks do PR #5; sem alteração funcional, merge ou deploy.

## Atualização Phase 4 — Reinício abrupto do worker

Adicionado cenário CI com worker filho real terminado por SIGKILL, aceitação HTTP durante paragem, recuperação da outbox após reinício e replay sem duplicar mensagem/auditoria. Ver [ADR-021](decisions/ADR-021-worker-restart-verification.md). Não cobre morte em processamento, indisponibilidade Redis ou failover DB. Lint local aprovado; execução integral nos checks do PR #5. Sem alteração funcional, merge ou deploy.

## Atualização Phase 4 — Avisos operacionais

Página de quarentena sinaliza ocupação ≥80%, capacidade esgotada, expiração próxima e limpeza pendente. Regras determinísticas no backend e capacidade partilhada com ingresso; traduções e testes adicionados. Ver [ADR-020](decisions/ADR-020-quarantine-operational-notices.md). São avisos da última consulta, não alertas enviados ou monitorização contínua. Notificações automáticas, revisão do conteúdo e reprocessamento continuam pendentes. CI nos checks do PR #5; sem ativação, merge ou deploy.

## Atualização Phase 4 — Consulta da quarentena

API e página Flutter de metadados, restritas a owner/admin, com paginação, contadores e prazos. Sem acesso ao conteúdo cifrado. Inclui seis idiomas, estados de UI e testes de isolamento/RBAC/respostas tardias. Ver [ADR-019](decisions/ADR-019-quarantine-metadata-operations.md). Validação integral nos checks do PR #5. Revisão do conteúdo, reprocessamento e alertas continuam pendentes. Phase 4 não concluída; sem ativação real, merge ou deploy.

## Atualização Phase 4 — Purga automática (schema 14)

Worker elimina payloads cifrados de quarentena expirados, em lotes de até 100, com auditoria transacional e descoberta independente de bindings WhatsApp. Mantém ledger/dedupe e não restaura conteúdo em replay. Ver [ADR-018](decisions/ADR-018-quarantine-retention-worker.md). Testes incluem scheduler separado e concorrência; CI nos checks do PR #5. Revisão/reprocessamento, alertas e política de backups continuam pendentes. Sem ativação real, merge ou deploy.

## Atualização Phase 4 — Quarentena cifrada (schema 13)

Eventos não suportados com âmbito de canal verificado podem ser capturados em quarentena AES-256-GCM, com chave independente opt-in, dedupe e auditoria. Sem executar IA/descarregar media/criar clientes. Ver [ADR-017](decisions/ADR-017-encrypted-whatsapp-quarantine.md). Expiração registada e DELETE restrito a expirados; purga automática/revisão ainda pendentes. Lint/testes locais do adapter aprovados; CI integral nos checks do PR #5. Sem ativação real, merge ou deploy.

## Atualização Phase 4 — Endpoint WhatsApp opt-in

GET/POST /webhooks/whatsapp implementados com default 404, raw-body, limite de tamanho e rate limit Redis. ACK apenas após commit durável. Configuração explícita server-side obrigatória; produção mantém bloqueio. Testes HTTP adicionados, lint local aprovado; CI nos checks do PR #5. Ver [ADR-016](decisions/ADR-016-whatsapp-http-gate.md). Endpoint não exposto/ativado; provisioning real e tratamento durável de media continuam pendentes. Sem merge/deploy.

## Atualização Phase 4 — Histórico de estados WhatsApp (schema 12)

Callbacks sent/delivered/read/failed são persistidos com idempotência, auditoria e RLS; histórico append-only preserva eventos fora de ordem. Não altera mensagens recebidas nem cria clientes. Ver [ADR-015](decisions/ADR-015-whatsapp-status-journal.md). Lint local aprovado; CI integral nos checks do PR #5. Correlação/estado visual de envios, endpoint público, media e outbound continuam pendentes. Sem merge/deploy.

## Atualização Phase 4 — Novos clientes inbound (schema 11)

Texto WhatsApp verificado pode cadastrar cliente na mesma transação da outbox. Índice tenant/telefone e lock impedem duplicação; arquivo não é revertido. Consentimentos explícitos com default unknown, sem inferência ou alteração de preferências existentes. Ver [ADR-014](decisions/ADR-014-inbound-customer-resolution.md). Lint local aprovado; validação integral nos checks do PR #5. Ingresso ainda interno, sem endpoint público, callbacks/media ou envios. Sem merge/deploy.

## Atualização Phase 4 — Outbox de origem externa (schema 10)

WhatsAppIngress liga assinatura, normalização, routing e outbox para texto de clientes existentes. Worker distingue autorização externa de membership mock e volta a validar o binding. Auditoria de origem externa sem utilizador fictício; batching partilhado. Ver [ADR-013](decisions/ADR-013-external-inbound-outbox.md). Testes de integração adicionados; CI nos checks do PR #5. Não existe endpoint público/provisioning real; novos clientes, callbacks e media permanecem pendentes. Sem merge/deploy.

## Atualização Phase 4 — Resolução de canal WhatsApp (schema 9)

Registo de encaminhamento interno com escrita reservada a provisioning confiável e resolver transacional por integração/WABA/número. Revalida canal live ativo, associa tenant via DB e mantém RLS sobre os dados. Ver [ADR-012](decisions/ADR-012-whatsapp-routing.md). Não ligado ao HTTP/outbox; origem externa sem utilizador, provisioning e auditoria de sistema ainda pendentes. Validação desta alteração nos checks do PR #5. Sem merge/deploy.

## Atualização Phase 4 — Adaptador inbound WhatsApp

Adicionado contrato de transporte e adaptador com validação de assinatura raw-body, challenge, normalização de texto/status e identificação de eventos não suportados. Ver [contrato e limites](whatsapp-inbound.md). Não ligado ao HTTP, à outbox ou a canais reais: este incremento é uma biblioteca backend testável, não integração WhatsApp concluída. Lint local aprovado; CI integral nos checks do PR #5. Sem merge/deploy.

## Atualização Phase 4 — Lock e batching inbound (schema 8)

Implementados lease Redis renovável por tenant/canal/cliente e lotes duráveis com janela de silêncio configurável, limite de cinco segundos e 50 eventos. Mensagens permanecem individuais e associadas ao lote; ainda não há consumidor IA nem resposta agrupada. Ver [ADR-011](decisions/ADR-011-conversation-lock-batching.md). Lint local aprovado; execução integral desta alteração nos checks do PR #5. Sem merge/deploy.

Entregas acumuladas: clientes e UI, canais mock, histórico e UI de conversas, outbox/worker/retries, lock e debounce mock. Continuam pendentes WhatsApp real, outbound, callbacks/media, handoff, IA e validação de falhas reais/stress. As secções seguintes são histórico das entregas e não substituem este resumo atual.

## Atualização Phase 4 — Outbox inbound

Receção mock agora assíncrona: HTTP 202 com recibo após commit durável; dispatcher PostgreSQL→BullMQ; worker valida tenant/canal/cliente/membership, grava mensagem e conclui envelope na mesma transação. Retry limitado com backoff, estados rejected/failed e limpeza do payload da outbox após processamento. Schema version 7. Ver docs/decisions/ADR-010-inbound-outbox.md e docs/messaging-sandbox.md.

Regressões adicionadas: consumo por worker separado, duplicação pós-commit, recibo cross-tenant, backlog enquanto fila pausada, retoma, canal revogado e limite de tentativas. CI integral aprovada no commit `af852ba`: https://github.com/HernanyManuel/Melissa/actions/runs/33649816928. Queda real de Redis e restart forçado ainda não testados; não equiparar teste de pause/resume a esses cenários. WhatsApp live, outgoing queue e locks/debounce de conversa permanecem pendentes. Sem merge/deploy.

## Phase 4 — Rascunho parcial: clientes

Continuação UI de conversas: `/conversations/:tenantId`, lista e histórico apenas de leitura, paginação, layout adaptado a mobile/desktop, seis idiomas, estados vazio/erro/loading e proteção contra respostas atrasadas após trocar conversa/empresa. Ações de envio e handoff não implementadas. Novos testes widget de recuperação de erro, leitura mobile/paginação e resposta atrasada. CI desta alteração pendente; Flutter indisponível localmente. CI do backend de mensagens `91c2197` aprovada: https://github.com/HernanyManuel/Melissa/actions/runs/33640469877.

Continuação mensagens: persistência transacional de eventos/conversas/mensagens para canais mock, dedupe, conflito de payload auditado, APIs de histórico paginado e testes. Ver [contrato e limitações](messaging-sandbox.md). Sem queue ou WhatsApp real nesta entrega; CI do novo commit pendente. CI do cadastro de canais `7d112dc` aprovada integralmente: https://github.com/HernanyManuel/Melissa/actions/runs/33638991311.

Continuação canais: cadastro/revogação de simulações WhatsApp com migration/RLS, IDs externos gerados, respostas sem secrets, permissões owner/admin e auditoria idempotente. Testes adicionados; ver [contrato e limites](channels.md). Não envia mensagens e não liga WhatsApp real. Validação local interrompida por autorização de rede; CI do novo commit pendente.

Interface de clientes no commit `93a1b33`: CI integral aprovada em https://github.com/HernanyManuel/Melissa/actions/runs/33638043602. As referências anteriores a UI pendente descrevem o estado antes desta execução.

Continuação UI: página Flutter `/customers/:tenantId` ligada à API, acessível pela empresa selecionada. Inclui lista paginada, criação, edição, confirmação de arquivo, estados de carregamento/vazio/erro, tratamento de telefone duplicado e traduções nos seis idiomas. Os controlos de escrita respeitam o papel devolvido pelo servidor; a API continua a autoridade de permissões. Novos testes widget cobrem lista vazia, staff sem escrita e formulário com duplicado. Flutter não está instalado localmente; execução na CI pendente para esta alteração.

CI do commit `99a6533` aprovada integralmente: https://github.com/HernanyManuel/Melissa/actions/runs/33637124294 (inclui novas regressões backend de clientes). Este resultado não valida a UI adicionada posteriormente.

Branch `feature/phase-4-messaging`, baseada em `feature/phase-3-business-onboarding` no commit `1c5c2507bdfd350b0b4bf4a475a579786bbeda36`. Publicação em rascunho autorizada pelo utilizador; não pronta para merge ou produção.

Código inicial: modelo Customer, migration com RLS forçada, telefone único por tenant, listagem paginada, criação, atualização integral e arquivo lógico, permissões específicas e auditoria transacional. CORS passa a permitir PUT/DELETE para a origem configurada. A especificação original permanece intacta.

Validação inicial: backend e Compose do commit `f4a450b` passaram na execução GitHub Actions `33636792678`. A tentativa local anterior de gerar Prisma foi interrompida por autorização de rede cancelada; os checks remotos permitem executar migrations e a suite existente sem ambiente do utilizador.

A continuação adiciona regressões HTTP/PostgreSQL para clientes à suite de integração existente: autenticação, isolamento A/B, validação, duplicados concorrentes, telefone por tenant, RLS sem contexto, paginação, atualização integral, arquivo e auditoria. Acrescenta teste unitário da matriz de permissões. Execução destas novas regressões pendente da CI do novo commit; testes HTTP de cada papel e UI ainda pendentes. Não confundir testes escritos com testes aprovados.

Ainda não entregue nesta fase: restantes campos do modelo especificado (incluindo consentimentos e preferências), canais, WhatsApp, conversas, mensagens, outbox, filas, debounce e media. Testes UI completos de edição/arquivo/paginação e testes HTTP por papel ainda pendentes. Nenhum envio real, merge ou deploy efetuado. A Phase 4 permanece incompleta, mesmo que os checks existentes passem.

Contrato inicial: `/api/v1/tenants/:tenantId/customers` aceita GET (50 itens e cursor `after`) e POST; `/:id` aceita PUT e DELETE (arquivo lógico). Owner/admin/manager podem ler e escrever; staff apenas ler; viewer sem acesso. O telefone continua reservado após arquivo. PUT substitui os campos editáveis e limpa email/notas omitidos; não constitui PATCH parcial. Arquivo não é eliminação definitiva de dados pessoais.

## Phase 3 — Onboarding e configuração

Branch `feature/phase-2-identity`, PR #3, base empilhada sobre PR #2. Código de contas, verificação/reset, sessões revogáveis, tenants, memberships, convites, RBAC, auditoria e RLS implementado. Flutter Web ligado, com seis idiomas e consentimento de desenvolvimento.

CI do commit `357d681` aprovado: backend (migrations, lint, typecheck, quatro testes unitários e duas suites de integração com PostgreSQL/Redis), Flutter (análise, seis testes e build Web), Compose e auditoria sem vulnerabilidades conhecidas. [Execução verificada](https://github.com/HernanyManuel/Melissa/actions/runs/33579326319). A revisão final alinha nomes físicos da DB com snake_case; os checks do commit mais recente estão no PR #3. Sem merge nem deploy.

Phase 3 adiciona perfil, templates, serviços, horários/exceções, equipa, FAQs, políticas e personalidade com migration, RLS, APIs e wizard Flutter localizado. Branch `feature/phase-3-business-onboarding`, PR #4 sobre o PR #3. Validação final nos checks do PR; sem merge nem deploy.

Ver [entrega e limites da Phase 3](phase-3.md), [segurança de identidade](phase-2.md) e [plano](../IMPLEMENTATION_PLAN.md). P4 corresponde a clientes, canais, WhatsApp, conversas e mensagens.
