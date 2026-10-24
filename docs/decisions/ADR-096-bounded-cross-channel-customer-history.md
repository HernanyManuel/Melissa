# ADR-096 — Contexto do cliente entre canais, limitado e de leitura

## Estado

Fatia incremental da Phase 8 no PR draft #7. Não implica merge, deploy nem integração live.

## Contexto

O painel do cliente (ADR-089) apresentava apenas os campos do perfil da conversa atual. Como a mesma identidade de cliente pode ter conversas distintas em canais diferentes, um operador autorizado precisava de saber que havia contactos anteriores, sem consultar mensagens de outras conversas nem criar um envio.

## Decisão

- Reutilizar o endpoint existente `GET /api/v1/tenants/:tenantId/conversations/:id/customer`, protegido por `customers:read` e pelo contexto de sessão/membership/RLS, preservando a forma e os campos originais de `item`.
- Acrescentar `relatedConversations: { items, hasMore }`. A consulta exige a existência da conversa e do cliente ativo no **tenant autorizado**, usa exatamente o `customerId` dessa conversa, exclui a conversa atual e ordena por `lastMessageAt DESC, id DESC`. Consulta **no máximo seis linhas**; devolve só cinco e calcula `hasMore` pela sexta, sem devolver um total global não autorizado.
- Projeção estrita de cada item: `id`, `status`, `lastMessageAt`, `channelName` obtido do nome público do canal. Não expor conteúdo de mensagens, notas internas, estado da IA, credenciais, consentimentos adicionais ou chaves de provider.
- O Flutter mostra as outras conversas no painel de cliente de leitura apenas, com data local e estados localizados, sem abrir automaticamente a outra conversa, alterar o cursor de leitura ou enviar mensagens. Em caso de falha, limpa os dados e permite repetir a consulta. Mudanças de tenant ou conversa invalidam respostas antigas.
- Mensagens localizadas pt/en/es/fr/it/de; sem novas tabelas, migração ou endpoint de escrita.

## Validação

Os testes backend criam múltiplos canais para um mesmo cliente, e um canal adicional associado a **outro cliente**. Verificam projeção, ordenação, exclusão da conversa atual, limite de cinco, sinalização `hasMore` e negação 404 a um ator de outro tenant. O teste Flutter verifica a presença da lista, indicação de mais conversas e ausência de qualquer envio.

## Limites

Trata-se de um resumo parcial e não de um histórico completo. Não existem ainda reservas no modelo Prisma do inbox nem associações de leads que permitam exibir uma agenda ou uma cronologia transacional; essas fontes exigirão contratos e permissões próprios. Uma alteração de atribuição ou permissões deverá continuar a ser refletida pelo endpoint autorizado; o painel não garante que outros canais estejam operacionais nem que uma mensagem tenha sido entregue. A retenção e eliminação de dados de clientes continuam a seguir as suas políticas específicas.
