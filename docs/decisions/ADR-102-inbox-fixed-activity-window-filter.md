# ADR-102 — Filtro de janela temporal fixa de atividade do inbox

## Estado

Implementado em `feature/phase-8-inbox`, PR #7 draft. [CI funcional #38226730460](https://github.com/HernanyManuel/Melissa/actions/runs/38226730460) integralmente verde no commit `a1c243e283d85e72d5b65801bde5210f1c001153`. Sem merge, deploy ou ativação real de serviços externos.

## Contexto

A ADR-100 acrescentou ordenação por `lastMessageAt DESC, id DESC` e a ADR-101 reforçou a pertença dos cursores a todos os filtros. Para operadores que precisam de ver apenas conversas com atividade recente, filtrar o resultado **antes** de paginar é essencial. Um parâmetro relativo `last=24h` recalculado pelo servidor em cada pedido mudaria silenciosamente a fronteira temporal entre a primeira e a segunda páginas, podendo invalidar cursores legítimos.

## Decisão

1. Aceitar `activitySince` opcional, em ISO 8601 UTC canónico `YYYY-MM-DDTHH:mm:ss.SSSZ`, validado por `@Matches` e `@IsISO8601({ strict:true, strictSeparator:true })`, rejeitando fusos alternativos, datas inexistentes e sintaxes não canónicas. Converter para `Date` **após** validação. A semântica é `lastMessageAt >= activitySince`, inclusive. `activitySince` omisso equivale a ausência de filtro e preserva o contrato anterior.
2. O predicado tenant-scoped `visibleWhere` da ADR-101 inclui `lastMessageAt: {gte: date}`, aplicado tanto à validação de `after` como à paginação normal Prisma. O SQL parametrizado de `unreadOnly=true` inclui `c.last_message_at >= :date::timestamptz` antes de `ORDER BY`/`LIMIT 51`; a projeção unread continua por ator, sem filtrar as 50 linhas apenas depois de paginar.
3. A UI Flutter escolhe `all|day|week|month`, interpreta day/week/month como últimos 1/7/30 dias, fixa a data no instante da seleção, converte para UTC e remove microssegundos para gerar três dígitos decimais. A mesma string acompanha `after`, sort, filtros existentes e reconciliação SSE->REST. A mudança de janela descarta cursores e respostas anteriores; mudança de tenant/revogação remove estado e data. Se o operador mantiver a janela selecionada por muito tempo, esta continua fixa até alterar a seleção.
4. Reutilizar índice existente `(tenant_id,last_message_at,id)` e schema 62; manter `messages:read`, tenant/RLS/RBAC, pontos de decisão de leitura, mensagens, workers, idempotência e fencing inalterados.

## Verificação

Os jobs backend, Flutter e Compose passaram, incluindo integração real PostgreSQL/RLS e worker, reexecução/recovery Redis, OpenAPI e build Web. O seletor de atividade foi deslocado da área de filtros para o cabeçalho compacto depois de a primeira execução detetar regressões de altura em testes a 800×600. A versão corrigida passou toda a suite Flutter, incluindo os testes existentes de pesquisa/paginação e seleção de conversa.


Integração HTTP com 51 conversas à mesma data e uma anterior: limite inclusivo, páginas de 50/1, desempate por ID, omissão/explicitação de sort, leitura unread na via SQL, validação 400 de datas inválidas e 404 de cursor fora do filtro ou tenant alheio. Widget test com presets 24h/7d/all e composição com `sort=recent`, `unreadOnly`, `after` confirma persistência exata do cutoff.

## Limites

Um limite temporal fixo não congela a base de dados: atividade posterior ao primeiro pedido pode reordenar conversas; o operador pode atualizar a listagem. Isto filtra `lastMessageAt`, não apenas mensagens recebidas, nem se transforma em SLA, previsão de resposta ou notificações externas.
