# ADR-027 — Consulta operacional do processamento inbound

Estado: incremento funcional da Phase 4.

## Contrato

GET `/api/v1/tenants/{tenantId}/message-processing`, owner/admin (`channels:manage`). `state` aceita pending (default), failed e rejected. `after` é UUID opcional, exclusivo, ordenado por ID. Página fixa de até 50 itens e next nulo no fim. OpenAPI define os DTOs.

Cada item contém apenas id do evento, state, attempts e nextAttemptAt. Attempts conta falhas registadas, não total de execuções. NextAttemptAt é elegibilidade para pending, não ETA; é null nos estados terminais. Não consulta payload, telefone, cliente, credenciais ou texto de erro interno.

InboundDispatch tem leitura global para o worker: o contexto RLS, isoladamente, não basta para esta tabela. A API exige autorização através de TenantService e inclui tenantId explicitamente no WHERE. Testes verificam acesso cruzado, listagem da outra empresa, RBAC e allowlist dos campos.

## Interface e limites

Flutter `/message-processing/:tenantId`, acessível pela conta para owner/admin. Filtros, paginação, seis idiomas, estados loading/vazio/erro, refresh manual e descarte de respostas atrasadas entre tenants/filtros. Erro remove metadados anteriores. Sem polling, cancelamento, retry manual ou mutação. Isto não substitui o painel admin global de jobs previsto para P10.

Estados podem mudar durante navegação: páginas não são snapshot e um evento processado pode desaparecer do filtro. Sem contagens totais para evitar scans adicionais. Escala elevada requer medir o plano de execução e avaliar índice composto tenant/state/id; este incremento reutiliza o schema atual e não comprova desempenho para milhares de tenants.

Testes HTTP incluem validação, paginação de 51 fixtures, isolamento e RBAC; widgets verificam GET-only, filtros/paginação, erro e resposta tardia mobile. Nenhuma mensagem é reenviada. Sem migration, merge ou deploy; CI no PR #5.
