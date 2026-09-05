# ADR-029 — Pesquisa de conversas por nome

Estado: incremento funcional da Phase 4.

## Contrato

GET `/api/v1/tenants/{tenantId}/conversations` aceita `q` opcional, string até 80 caracteres após trim. Vazio remove o filtro. Pesquisa substring literal, sem distinção de maiúsculas/minúsculas, nos nomes do cliente ou canal. `%`, `_` e barra invertida são escapados para não atuarem como padrões LIKE. Usa parâmetros Prisma, não concatenação SQL.

Tenant, autorização messages:read e RLS mantêm-se. Não pesquisa telefone, email, notas ou conteúdo das mensagens. Não remove histórico de clientes arquivados. Ordenação por ID, páginas de 50 e cursor existente mantidos; cliente conserva q ao paginar e reinicia cursor ao alterar pesquisa. Não promete snapshot entre páginas nem normalização de acentos.

## Interface

Campo, botão/tecla de pesquisa, limpar e vazio específico nos seis idiomas. Pesquisa explícita: não gera um pedido por tecla. Uma nova pesquisa limpa seleção/histórico e invalida pedidos anteriores. Mudança de tenant limpa o termo; respostas atrasadas não substituem resultados atuais. Parâmetros são codificados via Uri.

Testes HTTP: nome cliente/canal, case-insensitive/trim, vazio, ausência de match, metacaracteres literais, limite, parâmetros repetidos, cursor e isolamento. Widgets verificam query com caracteres especiais, paginação, limpeza e resultado tardio.

## Limites

Pesquisa substring em relações pode precisar de índices trigramas/estratégia dedicada com crescimento. Este incremento não afirma desempenho em grandes volumes: medir EXPLAIN ANALYZE e carga antes de aumentar escala. O índice de processamento do ADR-028 não acelera esta consulta. Sem schema novo, pesquisa full-text de mensagens, merge ou deploy.
