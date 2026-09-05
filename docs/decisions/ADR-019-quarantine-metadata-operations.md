# ADR-019 — Consulta operacional da quarentena

Estado: aceite para incremento parcial da Phase 4.

## Decisão

Disponibilizar GET `/api/v1/tenants/:tenantId/quarantine` e página Flutter `/quarantine/:tenantId`, apenas para owner/admin (`channels:manage`). O tenant do URL é um seletor: sessão, membership, autorização e RLS continuam a ser verificadas no backend.

A consulta seleciona exclusivamente ID do evento, ID/nome do canal e datas de receção/expiração. Não lê nem devolve ciphertext, nonce, tag, key ID, hash, telefone ou conteúdo. Não possui ações de alteração, decriptação ou reprocessamento.

Paginação fixa de 50 por ID UUID crescente, com cursor `after` validado. Não representa ordem cronológica nem snapshot entre páginas. Um cursor eliminado pela purga continua utilizável. Contadores total, expirados e a expirar nas próximas 24 horas são observacionais; podem variar durante uma purga concorrente. `asOf` regista o instante utilizado para classificar os prazos. Capacidade atual: 1000 eventos por tenant.

Flutter inclui seis idiomas, layout mobile/desktop, loading, erro com retry, vazio, paginação e proteção contra respostas atrasadas após troca de tenant. Em falha, remove dados anteriores da vista. A autorização visual não substitui a autorização da API.

## Verificação e limites

Testes de integração: autenticação, isolamento A/B, RBAC, cursor inválido, paginação sem sobreposição e allowlist de campos. Testes widget: erro/recuperação, paginação mobile e resposta tardia de outro tenant. CI integral no PR #5; sem Flutter local.

Não requer migration (schema 14). Revisão do conteúdo, reprocessamento idempotente, alertas e operação/rotação de chaves permanecem pendentes. Não ativa Meta, não faz merge nem deploy.
