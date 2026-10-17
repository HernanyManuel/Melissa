# ADR-111 — Dispatch seguro e recuperação do inbox Stripe TEST

## Estado

Implementação em `feature/phase-8-inbox`, PR #7 draft, schema **69**. Validar o CI no SHA final. Sem pagamentos live, acesso pago, deploy, merge ou worker de produção.

## Contexto

As ADR-105, ADR-106 e ADR-110 estabelecem, respetivamente, o inbox de webhooks Stripe test assinado, a reconciliação por provider snapshot e a associação inicial por Checkout test. Porém, as duas últimas operações só podiam ser invocadas por CLI com IDs explícitos; a entrega de eventos não era agendada nem havia leases, retries ou dead-letter.

## Decisão

- A migration 69 cria `stripe_event_dispatch` (pending/leased/complete/dead) e `stripe_dispatch_attempts` append-only com número de tentativa, ação e motivo sanitizado. A evidência original em `stripe_webhook_events` continua imutável (`status=received`).
- Um trigger PostgreSQL `SECURITY DEFINER` com `search_path=pg_catalog`, sem EXECUTE público, insere **atomicamente** uma linha na fila após persistência de evento assinado. Eventos preexistentes são backfilled. A API não recebe SELECT/INSERT/UPDATE/DELETE sobre a fila, e o trigger não valida pagamento.
- O novo papel `melissa_billing_dispatcher` começa em `NOLOGIN`; só seleciona e atualiza colunas de estado/lease da fila e grava/consulta o jornal de tentativas. Não tem SELECT do payload de Stripe, das subscrições, das empresas ou do catálogo. Nem ele nem o papel da API ganham privilégios de associação/reconciliação.
- A CLI **opt-in em ambiente de teste**, `pnpm --filter @melissa/backend stripe:dispatch-test [1..20]`, exige simultaneamente `NODE_ENV=test`, `STRIPE_TEST_DISPATCH_ENABLED=true`, `STRIPE_TEST_LINK_ENABLED=true`, `STRIPE_TEST_RECONCILE_ENABLED=true`, `STRIPE_TEST_SECRET_KEY=sk_test_...` e três URLs de base de dados **independentes**: `BILLING_DISPATCHER_DATABASE_URL`, `BILLING_LINKER_DATABASE_URL`, `BILLING_RECONCILER_DATABASE_URL`. Provisionar o login de dispatcher manualmente apenas num DB de teste com `infra/scripts/billing-dispatcher-login.sql`. A CLI processa um lote e termina; não inicia automaticamente nenhum serviço ou agendador.
- A seleção de tarefas usa `FOR UPDATE SKIP LOCKED`, com lease de **90 segundos** e token UUID; uma instância em atraso não consegue finalizar a tarefa reclamada por outra. Um crash deixa um registo append-only `claimed`, e o lease pode ser recuperado após expiração. A decisão final e a tentativa de auditoria são registadas na mesma transação.
- Atrasos de retry: **30 s, 120 s, 480 s, 1800 s, 1800 s**, até **6 tentativas**, depois `dead` sem retry automático. `unmapped`, `unknown_checkout` e indisponibilidade do provider são temporários; eventos inválidos são concluídos com decisão sanitizada `rejected`, e pedidos processados com sucesso ficam em `complete`.
- Um evento `checkout.session.completed` chama apenas o associador dedicado da ADR-110 e confirma o Checkout diretamente na Stripe test. Os restantes eventos suportados passam pelo reconciliador da ADR-106, que só atualiza subscrições **já associadas**. Se o evento da subscrição chegou antes de o Checkout estar associado, ficará em retry. Nem o dispatcher nem os handlers aceitam identificadores de tenant do webhook como autoridade.
- Os testes verificam o trigger, deduplicação, papéis/RLS, contrato de leases, recuperação após crash, idempotência, associação/reconciliação de teste, provider simulado indisponível e dead-letter. Não substituem testes end-to-end com conta Stripe sandbox.

## Limites e próximos passos

O lote necessita execução explícita pelo operador ou agendamento **somente na infraestrutura de teste**. Não é integrado no worker geral da Melissa, que usa `melissa_runtime`; esse papel não possui credenciais de Stripe nem pode consumir a fila. Reexecução de dead-letter, alertas, métricas e integração com sandbox real exigem um runbook de operador e validação adicional. Não é uma máquina de estados de faturação nem valida o valor liquidado de um invoice.

Os estados `billingVerified=false` e `automationEnabled=false` mantêm-se. Antes de ativar cobranças reais ou entitlements: Customer Portal test, política de planos/quotas, verificação de montantes pagos, E2E no Stripe sandbox, gestão de segredos/infra e autorização explícita.
