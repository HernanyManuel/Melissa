# ADR-112 — Customer Portal Stripe de teste, estritamente de leitura

## Estado

Implementado em `feature/phase-8-inbox` / PR #7 draft, schema 70. Confirmar o CI **do HEAD final**. Sem Stripe sandbox E2E real, pagamento live, merge, deploy ou entitlements.

## Contexto e decisão

Após as ADRs 109–111, as subscrições Stripe test só são associadas a um tenant por uma intenção de Checkout persistida e verificada diretamente no Stripe, e o inbox dispõe de dispatch controlado em modo de teste. O Customer Portal é um URL de acesso sensível que pode permitir alterações financeiras: não pode ser aberto só com um customer ID vindo do browser, sem validação da configuração e do vínculo.

1. O endpoint `POST /api/v1/tenants/:tenantId/billing/portal` fica **desativado por defeito**, protegido por autenticação, `TenantService.scoped` e `billing:write` (owner/admin). Não aceita parâmetros de customer, subscription, configuração, return URL ou fluxo enviados pelo cliente.
2. Para ativar exclusivamente em `NODE_ENV=test`, exigem-se `STRIPE_TEST_PORTAL_ENABLED=true`, chave `STRIPE_TEST_SECRET_KEY=sk_test_...`, `STRIPE_TEST_PORTAL_CONFIGURATION_ID=bpc_...` e a origem de retorno exata e segura `STRIPE_TEST_CHECKOUT_RETURN_ORIGIN`. O modo produção continua indisponível.
3. Migration 70 concede ao `melissa_runtime` **apenas SELECT** das três colunas `provider_customer_id`, `provider_subscription_id` e `checkout_session_id`, preservando FORCE RLS por `app.tenant_id`. Não concede nenhuma mutação de subscrições.
4. A subscrição local deve ser Stripe, estar `active`, ter uma intenção Checkout `ready` com o mesmo tenant, plano e `cs_test_...`; o plano continua ativo e com preço Stripe. A API valida novamente esses vínculos e a autorização **depois** de contactar o fornecedor e antes de revelar a URL.
5. A chamada REST usa o host fixo `https://api.stripe.com`, versão `2025-09-30.clover`, HTTPS, GET sem redirecionamentos, tempo limite de 5 s e resposta limitada a 128 KiB. Exige subscrição atual `livemode=false`, `status=active`, `customer` e `price` iguais aos valores locais, um único item, período válido e sem trial.
6. Antes de criar a sessão, consulta `GET /v1/billing_portal/configurations/:id` e exige configuração **ativa, de teste, com `invoice_history.enabled=true` e todas as demais funcionalidades desativadas**; login page pública também desativada. Qualquer recurso de atualização de dados do cliente, subscrição, cancelamento ou método de pagamento bloqueia a emissão.
7. Só então usa `POST /v1/billing_portal/sessions`, com customer/configuração originados no servidor e `return_url` fixo. Valida `livemode=false`, customer, configuração, retorno, data recente e URL exclusivamente em `https://billing.stripe.com/p/session/test_...`.
8. Aplica limitação por tenant de uma emissão a cada 30 segundos usando auditoria PostgreSQL e transações serializadas por lock de tenant. Regista apenas `billing.portal.created` e o ID da subscrição; o token/URL Portal **não é armazenado** em BD nem no audit log.
9. **O Portal é só de consulta do histórico de faturas.** Não habilita alteração contratual, alteração de pagamento, cancelamentos, Customer Portal mutável, `billingVerified`, `automationEnabled`, quotas nem onboarding pago. O cliente Flutter permanece read-only nesta fatia.

## Verificação e limites

Testes de adaptador usam responses Stripe simuladas para validar `livemode`, preço/cliente, configuração sem mutações, host de retorno e falha fechada. Integração HTTP usa Nest, RBAC, PostgreSQL/RLS real e gateway simulado para 401/403/404/409, throttle 429, associação local válida, auditoria sem URLs e entitlements desativados.

A configuração Stripe remota pode ser alterada por operadores fora do código: a validação GET reduz risco, mas é necessário um procedimento de governação e testes reais no sandbox antes de tornar este Portal disponível a clientes. Como ainda não foi estabelecida verificação definitiva do ledger de pagamentos nem aplicação de quotas, nenhum estado Stripe sozinho concede funcionalidades pagas.
