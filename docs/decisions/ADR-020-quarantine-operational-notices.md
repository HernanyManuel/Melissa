# ADR-020 — Avisos operacionais de quarentena

Estado: aceite; incremento parcial da Phase 4.

## Decisão

A resposta existente de metadados inclui `notices`, uma lista de códigos sem conteúdo sensível. Calculados a cada consulta autorizada, sem novas leituras globais, escrita, decriptação, email ou serviços externos.

| Código | Condição | Significado |
| --- | --- | --- |
| capacity_warning | 800 ≤ total < 1000 | Pelo menos 80% da capacidade ocupada |
| capacity_full | total ≥ 1000 | Novos eventos que necessitem de quarentena serão recusados |
| cleanup_pending | expired > 0 | Há payloads elegíveis para limpeza, não prova falha do worker |
| expiring_soon | expiringSoon > 0 | Conteúdo elegível para eliminação dentro de 24 horas |

Capacidade partilhada entre a validação de ingresso e a API. Duplicados já registados continuam idempotentes quando o limite é atingido; o aviso não significa que todo o tráfego WhatsApp seja recusado.

Flutter traduz os códigos nos seis idiomas, usa ícone/texto (não apenas cor) e região semântica de aviso. Desconhecidos não são apresentados. Avisos são limpos ao atualizar, trocar tenant ou falhar autorização/rede, evitando apresentar dados anteriores como atuais. Sem polling: refletem a última consulta concluída, não monitorização em tempo real.

## Limites e verificação

Não são incidentes persistentes nem notificações automáticas. Deduplicação de alertas, escalonamento, canais de notificação e operação de suporte continuam pendentes. Não implementa os alertas de billing/usage da especificação. Contadores permanecem observacionais, sem snapshot durante purga concorrente. A página não recupera conteúdo nem prolonga a retenção.

Testes unitários cobrem fronteiras 799/800/999/1000 e recuperação; integração verifica avisos e isolamento; widgets verificam mobile, aviso desconhecido, recuperação e erro. CI integral no PR #5. Sem migration, ativação real, merge ou deploy.
