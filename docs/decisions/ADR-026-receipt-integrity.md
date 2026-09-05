# ADR-026 — Integridade dos recibos inbound

Estado: correção da Phase 4.

## Problema

A consulta de recibos aceitava qualquer evento do ledger do tenant e inferia processed quando não existia inbound_dispatch. Isso podia apresentar uma quarentena ou callback de estado como mensagem concluída, mesmo sem mensagem associada.

## Decisão

Aceitar apenas eventos message.received dos providers mock/whatsapp, sujeitos à autorização/RLS existente. Outros eventos devolvem 404. Um registo de dispatch ausente, estado desconhecido ou evidência incoerente devolve 503 sanitizado: nunca inferir sucesso.

Processed exige dispatch processed, mensagem associada e processedAt. Pending/rejected/failed não podem possuir mensagem. O worker e a consulta usam o lock do tenant, evitando observar uma escrita parcial normal. Inconsistências requerem diagnóstico; repetir GET pode recuperar uma indisponibilidade, mas criar nova mensagem não é reparação.

Mantém formato de resposta para recibos válidos e estados reais. Sem alteração do schema ou dos dados existentes. Se no futuro for eliminado inbound_dispatch, a estratégia de recibo histórico terá de ser definida explicitamente, não por fallback.

## Verificação

Testes unitários cobrem combinações válidas/inválidas. Integração HTTP cobre ledger de quarentena/estado, evento inbound sem dispatch, autenticação, isolamento e erro sanitizado. Flutter verifica que 503 na consulta não mostra processed nem repete POST; uma consulta posterior pode concluir. Integrações existentes continuam a verificar pending/processed/rejected/failed.

Sem reprocessamento, reconciliação automática, merge ou deploy. CI no PR #5.
