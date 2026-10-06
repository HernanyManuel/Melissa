# ADR-061 — Coordenador de turno antes do wiring assíncrono

- Estado: aceite
- Data: 2026-09-08

## Contexto

Context builder, engine, tools, fencing e ledger existiam como componentes separados. O worker precisa de uma única fronteira que imponha ordem, replay e classificação de falhas. A outbox existente, porém, representa ações humanas de sandbox: exige `actor_id` e aceita apenas provider mock. Reutilizá-la para IA atribuiria falsamente a ação a uma pessoa.

## Decisão

`ConversationTurnCoordinator` executa a sequência: validar scope confiável, iniciar ledger, suprimir replay concorrente/concluído, selecionar tools no registry server-side, construir contexto, executar engine e finalizar usage antes de devolver qualquer texto.

O coordenador classifica somente códigos sanitizados: contexto indisponível, provider, execução, resultado inválido ou fencing obsoleto. `ConversationExecutionStale` transporta apenas contadores de rondas/tools e usage acumulado, permitindo medir uma chamada já consumida sem expor conteúdo. Erro ao persistir a finalização não é convertido em resultado funcional: propaga para que o futuro worker faça retry.

## Consequências

- Um job repetido não volta a chamar provider quando o turno já está em curso ou concluído.
- Conteúdo só sai do coordenador depois do registo terminal e de usage.
- Este componente continua sem I/O de fila e sem persistir conteúdo de resposta.
- O próximo schema deve separar outbound automático de intenções humanas, mantendo proveniência e idempotência explícitas.
