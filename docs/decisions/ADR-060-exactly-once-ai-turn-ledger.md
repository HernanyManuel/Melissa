# ADR-060 — Ledger exatamente-once para turnos de IA

- Estado: aceite
- Data: 2026-09-08

## Contexto

O `ConversationEngine` devolve contadores de tokens, rondas e tools, mas retries de worker podem repetir a mesma entrega. Persistir apenas logs perderia faturação e auditoria; persistir prompts/respostas aumentaria exposição de dados pessoais. Não é aceitável manter uma transação aberta durante uma chamada ao provider.

## Decisão

O schema 22 cria `ai_turns` e `ai_usage_events`, ambas com chave composta tenant, RLS forçada e FKs compostas. O `turn_id` nasce antes da inferência e identifica imutavelmente conversation, customer, `mode_epoch` e `state_version`.

`AITurnLedger.begin` usa insert-on-conflict e só aceita replay quando todo o scope coincide. `finish` muda exclusivamente `running` para um estado terminal e insere o único evento de usage na mesma transação. A unicidade `(tenant_id, turn_id)` e o predicado `status='running'` tornam a finalização exatamente-once mesmo sob concorrência. O evento de usage é append-only para a role runtime.

Persistem apenas IDs internos, versões, provider/model configurados, contadores, resultado e código de falha sanitizado. Prompts, respostas, conteúdo das mensagens e argumentos/resultados de tools não pertencem ao ledger.

## Consequências

- Um retry distingue turno novo, em curso e terminado sem repetir contabilização.
- Falha na inserção de usage reverte também a transição terminal.
- Pricing/custo não é calculado aqui; requer catálogo versionado posterior para não reescrever história.
- A ligação ao worker, outbound intent e reconciliação de turnos abandonados continuam separadas.
