# ADR-097 — Filtro de triagem do inbox por modo do canal

## Estado

Implementado na `feature/phase-8-inbox` para o PR #7 draft. Sem merge, deploy ou autorização de WhatsApp live. CI do commit final deve ser verificado separadamente.

## Contexto

O mesmo tenant pode conter conversas de testes em ligações `mock` e conversas associadas a ligações `live`. Um operador precisa de as distinguir na triagem sem expor credenciais nem alterar o fluxo de envio. As ADR-090 a ADR-093 já fixaram filtros do inbox aplicados no servidor antes de `LIMIT 51`, e a ADR-094 exige refresh autorizado antes de persistir o checkpoint SSE.

## Decisão

- `GET /api/v1/tenants/:tenantId/conversations` aceita `channelMode=all|mock|live`; `all`/omissão preserva o resultado anterior e valores fora da enumeração devolvem 400. Trata-se de `channel_connections.mode`, não de `conversations.mode` (que rege o controlo humano/IA).
- A transação existente `TenantService.scoped(actor, tenantId, 'messages:read', ...)` e as RLS não mudam. A consulta normal usa o relacionamento Prisma `channelConnection.mode`; a via `unreadOnly=true` aplica `EXISTS` parametrizado na ligação composta `(tenant_id, channel_connection_id)` **antes** da ordenação e de `LIMIT 51`. Não se filtram apenas linhas já devolvidas ao cliente.
- Para paginação, `after` tem de identificar uma conversa tenant-scoped cujo `status`, `tagId` e `channelMode` correspondam aos filtros selecionados, caso contrário 404. O cliente conserva o modo em cada página e nos refreshes SSE. Mudanças invalidam a geração de listagem e impedem callbacks de filtros antigos de atualizar a vista.
- A UI oferece um menu compacto, com traduções pt/en/es/fr/it/de, para «Todos os modos de canal», «Simulados» e «Ao vivo». A consulta não dá acesso a credenciais ou IDs de provider além da projeção anterior, nem interfere com contadores de não lidas, cursores, notas, etiquetas ou operações de resposta.
- Não há migração, endpoint de escrita, alteração de `mode_epoch`, idempotência de envio, fencing, workers, checkpoint ou integrações. O schema permanece 62.

## Testes

A suite HTTP exercita filtros `all/live/mock`, valores inválidos, outro tenant, rejeição de cursor incompatível e combinação com `status=closed` e `unreadOnly=true`, com duas ligações de modos distintos e eventos reais `message.received`. O widget test verifica mudança de modo, paginação, composição com estado/não lidas e reset do cursor. Permanecem em vigor os testes de SSE, autorização, recuperação e respostas humanas das ADR anteriores.

## Limites e risco

O modo da ligação é informação operacional e não comprova disponibilidade do provider; não se tenta enviar uma mensagem nem inferir consentimento por filtrar `live`. Não há seleção de uma ligação individual, E2E Meta, notificações fora da aplicação, retenção nova ou sincronização multi-dispositivo específica. Qualquer ativação real depende da autorização e dos gates já documentados.
