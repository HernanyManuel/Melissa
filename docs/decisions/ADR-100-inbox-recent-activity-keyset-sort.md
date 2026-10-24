# ADR-100 — Ordenação estável do inbox pela última atividade

## Estado

Implementado incrementalmente na `feature/phase-8-inbox`, PR #7 draft, validado integralmente no [CI #38220494598](https://github.com/HernanyManuel/Melissa/actions/runs/38220494598), commit `f8958a59c87967ebe79344f284c01dabac05be6b`. Sem merge, deploy ou ativação live.

## Contexto

Até à ADR-099, o inbox paginava por `conversations.id ASC`, adequado a cursores técnicos mas pouco útil para atendimento. Apresentar atividade mais recente primeiro melhora a triagem, desde que mantenha compatibilidade, autorização tenant/RLS, filtros e ordenação antes da paginação, em ambas as vias Prisma e SQL das conversas por ler. Datas iguais não podem perder conversas ao virar de página.

## Decisão

1. Novo `sort=id|recent` validado no DTO e descrito em OpenAPI. Omisso/`id` mantém o comportamento histórico por UUID ascendente; `recent` ordena por `lastMessageAt DESC, id DESC`. Não assumir ordenação implícita da base de dados. O ID é um desempate total na mesma lista.
2. Prisma usa `orderBy` composto e o cursor por `tenantId_id` com `skip:1`. A query de `unreadOnly=true`, em SQL parametrizado sob a transação tenant/RLS, compara os pares de colunas do PostgreSQL em precisão nativa: `(c.last_message_at,c.id) < (SELECT anchor.last_message_at,anchor.id ... WHERE tenant_id=:tenantId AND id=:after)`, ordena pela mesma chave e aplica `LIMIT 51` depois de procurar, filtrar e verificar eventos inbound ainda por ler pelo ator. O resultado hidratado é ordenado pela mesma chave composta, não por UUID.
3. O cursor `after` continua a ser UUID, sem revelar timestamps no contrato. A validação de tenant, modo de controlo, canal, etiqueta e estado de ciclo de vida mantém 404 para cursores incompatíveis. Um `after` não deve ser reutilizado quando o utilizador muda `sort` ou qualquer outro filtro.
4. Flutter oferece apenas uma ação compacta no cabeçalho, reutilizando o espaço horizontal existente, com `id` por predefinição e `recent` como opção. Adiciona `sort` nas páginas e nos refreshes SSE->REST, e usa a geração de listagem para descartar uma resposta tardia cuja ordenação já mudou. Troca de tenant e revogação restabelecem `id`. Rótulos em pt/en/es/fr/it/de.
5. Nenhuma transição de estado, efeito de leitura, mensagem enviada, alteração a `mode_epoch`, redispatch, credencial externa ou nova migração. O índice existente `(tenant_id,last_message_at,id)` é reutilizado; schema 62.

## Verificação e limites

O workflow validou os três jobs: backend (lint, formatação, tipos, unitários, PostgreSQL/RLS, integração com worker separado, recuperação após restart/Redis, OpenAPI e dependências), Flutter (localização, análise, widgets e build Web) e Docker Compose readiness.

Testes HTTP criam 52 conversas mock/pausadas, 51 com o mesmo timestamp e uma anterior; cobrem duas páginas sem lacunas, empate por UUID, `sort=id`, erro 400, outro tenant 404, cursor incompatível 404 e a consulta `unreadOnly=true` com eventos inbound para as 51 conversas. Widget test verifica ordem recente, propagação nas páginas, combinação com `controlMode` e não lidas, reset do cursor ao regressar a ID e tradução.

A paginação é keyset sob o estado atual da conversa, não snapshot isolado entre pedidos; nova atividade pode alterar a posição de uma conversa entre páginas. Um refresh restaura a primeira região visível. A aplicação não define disponibilidade humana ou entregabilidade do provider por este campo. Não há notificações externas nem E2E Meta real.
