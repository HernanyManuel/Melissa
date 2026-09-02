# Billing, entitlements e utilização

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
