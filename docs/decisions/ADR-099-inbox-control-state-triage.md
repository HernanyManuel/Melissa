# ADR-099 — Triagem por estado de controlo da conversa

## Estado

Implementação na `feature/phase-8-inbox`, PR #7 draft. CI de verificação do incremento ainda em curso. Sem merge, deploy ou serviços live.

## Contexto

ADR-076 fornece o controlo humano com fencing e reativação da IA; as ADR-090 a ADR-098 já introduziram filtros de triagem por tags, atribuição, não lidas, ciclo de vida e canal. Falta distinguir operativamente conversas em atendimento humano, IA ativa e IA em pausa, sem executar qualquer transição de estado. O `mode` da conversa não deve ser confundido com o `mode` da ligação ao canal.

## Decisão

- `GET /api/v1/tenants/:tenantId/conversations?controlMode=all|human|ai|paused`: omisso ou `all` preserva o comportamento anterior. Os três filtros específicos são igualdade exata de `conversations.mode`: `human → HUMAN_ACTIVE`, `ai → AI_ACTIVE`, `paused → AI_PAUSED`. Valores inválidos, maiúsculas ou enums internos não aceites devolvem HTTP 400; `CLOSED` só aparece em `all`, sendo a triagem de encerradas independente por `status=closed`.
- A decisão de autorização continua `TenantService.scoped(actor, tenantId, 'messages:read', ...)` com PostgreSQL RLS. A implementação parametriza o predicado na via `unreadOnly=true` e adiciona a mesma igualdade nas queries Prisma de seleção e validação do cursor. O predicado é avaliado **antes** da paginação. Um `after` com estado de controlo diferente ou que tenha transitado dá 404. Não tenta reconstruir um snapshot histórico entre páginas.
- O filtro compõe com `status`, `assignment`, `tagId`, `q`, `unreadOnly`, `channelId` e `channelMode`, preservando o cursor pessoal de leitura de eventos. Não há novo endpoint de escrita, permissão, efeito na outbox ou transição implícita de controlo.
- Na UI, um menu com quatro rótulos traduzidos fica no cabeçalho existente junto ao refresh, sem nova linha na barra lateral. Mudanças de seleção recomeçam na primeira página, invalidam resultados de listagem tardios e mantêm o filtro nos refreshes SSE confirmados por REST. A seleção não marca mensagens como lidas nem cria intents.
- Não há migração: schema 62; `mode_epoch`, `stateVersion`, locking/fencing, idempotência, envios e recuperação de worker permanecem inalterados.

## Verificação

A integração exercita seleção após takeover e reativação, exclusão do encerrado, validação 400, outro tenant 404, cursor de modo incompatível 404, seleção paginada de 52 conversas em pausa e combinação com não lidas de um canal mock. Testes Flutter verificam labels, composição com estado/não lidas, manutenção de cursor na segunda página e reset ao mudar de modo.

## Limitações

O controlo humano persistido não indica disponibilidade online do operador, e a pausa da IA não indica motivo de indisponibilidade. Conjunto de resultados pode mudar entre páginas quando há takeover/reativação concorrente; nesse caso o cursor deixa de ser válido e deve reiniciar a listagem. Sem push/email externo ou E2E Meta live; qualquer ativação exige autorização própria.
