# ADR-110 — Associação inicial verificada de Checkout Stripe em modo de teste

## Estado

Implementado em `feature/phase-8-inbox` / PR #7 draft, com migration **68**. O CI e os testes de Stripe real em sandbox não são presumidos: confirmação do **SHA final** obrigatória. Não existe cobrança live, deploy nem entitlement.

## Contexto

A ADR-109 gerava uma sessão Stripe Checkout `cs_test_...` vinculada a uma intenção local com `tenant_id`, `plan_id` e `price_id`, mas não criava `subscriptions`. A ADR-106 só reconcilia assinaturas Stripe previamente ligadas ao tenant. O webhook da ADR-105 verifica a assinatura e guarda o evento original, mas não pode ser autoridade para `tenant_id`/metadata.

## Decisão

1. Acrescentar `subscriptions.checkout_session_id` (único, opcional para snapshots existentes) e `stripe_checkout_link_attempts` append-only com auditoria de `linked|replayed|rejected|deferred` (schema 68).
2. Criar **`melissa_billing_linker`**, um papel PostgreSQL `NOLOGIN` por omissão, sem superuser, bypass RLS, `CREATEDB`, `CREATEROLE` nem `INHERIT`. Só pode ler eventos Stripe assinados imutáveis, ler intenções Checkout e IDs de preço/plano, consultar associações existentes, inserir uma subscrição nas colunas restritas, e inserir/ler auditoria. Não pode alterar ou apagar subscrições, catálogo, intenções, eventos, empresas ou auditoria. Runtime/reconciler não recebem INSERT em `subscriptions`.
3. RLS `FORCE` em `subscriptions` limita o INSERT do linker a `provider='stripe'` e a intenção previamente registada com o mesmo `tenant_id`, `plan_id`, `checkout_session_id`, `price_id` e `status='ready'`; o plano tem de continuar publicado. Unicidades de tenant, Stripe customer, Stripe subscription e sessão impedem associações múltiplas. As políticas globais de leitura do papel linker não são acesso à API.
4. Comando **exclusivamente offline** de teste `pnpm --filter @melissa/backend stripe:link-test evt_...`, com `NODE_ENV=test`, `STRIPE_TEST_LINK_ENABLED=true`, `STRIPE_TEST_SECRET_KEY=sk_test_...` e `BILLING_LINKER_DATABASE_URL`. Papel tem LOGIN só após aprovisionamento manual `infra/scripts/billing-linker-login.sql` numa base de testes descartável.
5. Aceitar apenas `checkout.session.completed` já persistido no inbox assinado. Do payload retira-se **somente `data.object.id`** (session ID). Localizar a intenção **pelo ID da sessão**, ignorando `metadata.tenant_id`, `client_reference_id`, customer e subscription presentes no evento.
6. Consultar **diretamente** a sessão Stripe test pelo endpoint fixo `GET /v1/checkout/sessions/:id`, em `2025-09-30.clover`, e exigir `livemode=false`, `mode=subscription`, `status=complete`, `payment_status=paid`, ID/sessão correto, referência exata à intenção e expiração compatível com o registo local. Não aceitar pagamento `unpaid` ou `no_payment_required`; trials/grace são política posterior.
7. Consultar subscrição atual pelo provider (`GET /v1/subscriptions/:id`) e exigir exatamente um item, preço igual ao mapeamento do plano, cliente igual ao da sessão, `status=active`, período válido e sem trial. O produto não admite itens múltiplos ou upgrades durante a associação inicial. Fetches limitados a 5 segundos, 128 KiB, HTTPS host fixo, sem redirects, chaves test e sem logging dos dados.
8. Bloquear por intenção dentro da transação PostgreSQL (advisory lock) e fazer consulta provider/validações, deteção de conflitos de tenant, customer, subscription ou Checkout, INSERT e auditoria na mesma transação. Um replay idêntico apenas regista `replayed`; eventos divergentes e tentativas de cross-tenant são rejeitados.
9. O estado `active` fica apenas como **snapshot de fornecedor**, ainda sem `billingVerified`, quotas, ledger ou verificação de preço comercial integral. **`automationEnabled=false`**, `billingVerified=false` e bloqueio de onboarding permanecem. O linker não altera estados do tenant, não concede funcionalidades pagas, não captura pagamentos nem prepara Customer Portal.

## Verificação e limites

Testes unitários validam sessão Stripe test, modos pagos/não pagos, origem e credenciais. Testes de integração com PostgreSQL real e papel mínimo (Stripe provider mock) cobrem associação, replay, tenant estrangeiro malicioso, troca de cliente, mismatch de sessão, eventos não elegíveis, provider indisponível e grants negados. São **testes simulados do provider**, não comprovam pagamento na conta Stripe sandbox.

O `billing:read` e o Flutter permanecem read-only. A CLI é uma ação explícita de operador, ainda não um worker de reconciliação/ligação automática; não há alteração de preço/plano, ligação de várias localizações, trial, recuperação de custos nem qualquer ativação comercial. Antes de produção: Stripe sandbox real, audit/retry automatizado, Customer Portal, política de entitlements/usage, testes E2E e autorização explícita.
