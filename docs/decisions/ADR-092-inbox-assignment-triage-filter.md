# ADR-092 — Triagem do inbox por atribuição de colaborador

## Estado
Fatia incremental da Phase 8 em PR draft; sem merge, deploy ou integração WhatsApp live.

## Decisão
A listagem `GET /tenants/:tenantId/conversations` recebe um parâmetro opcional `assignment=all|mine|unassigned`, validado no DTO. A opção `all` (e a ausência do parâmetro) preserva o comportamento anterior; `unassigned` seleciona as conversas cujo `assigned_staff_id IS NULL`; `mine` seleciona apenas conversas cujo colaborador associado possui `staff.user_id` igual ao utilizador da sessão autenticada. **O cliente nunca fornece um userId nem um staffId arbitrário**.

O filtro aplica-se na base de dados, antes do limite de paginação de 50, tanto no caminho Prisma normal como no SQL de `unreadOnly=true`; combina-se com pesquisa literal, etiqueta e cursor. Não confere novas permissões de leitura nem altera o modo ou a atribuição da conversa. Só `conversations:takeover` (pelos endpoints existentes) pode modificar a atribuição.

O Flutter mostra um seletor «Todas as atribuições / Atribuídas a mim / Sem atribuição» com traduções pt/en/es/fr/it/de. As consultas e refresh SSE preservam o filtro; mudar a escolha reinicia a paginação, e mudar de tenant ou perder acesso limpa o estado.

## Testes e limites
Os testes HTTP validam opções inválidas, ausência de atribuição, associação com staff do ator, isolamento entre operadores e combinação com o filtro de não lidas. Teste Flutter cobre alterações de filtro e preservação de `unreadOnly`.

Este filtro representa atribuição a registos de staff ligados ao ator, não uma caixa de correio partilhada ou uma nova regra de autorização. Atribuições alteradas em simultâneo com paginação podem alterar o conjunto apresentado; não garante snapshot global estável entre páginas. Sem notificações do sistema, deploy ou envios a clientes.
