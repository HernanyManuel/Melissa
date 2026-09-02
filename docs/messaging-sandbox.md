# Conversas e mensagens — persistência de teste

Entrega parcial da Phase 4 (§§16–18). Não é webhook WhatsApp nem motor de IA. Usa apenas canais mock e clientes existentes. Nenhum envio externo.

## Contrato

- `POST /api/v1/tenants/:tenantId/channels/:id/mock-inbound`: owner/admin; corpo `customerId` UUID, `eventId` UUID estável e `text` de 1–4096 caracteres. Retorna `duplicate` e `message`; 200 também para repetição idêntica, 409 se o mesmo evento tiver outro conteúdo. Os IDs de cliente/canal têm de pertencer ao tenant autenticado; cliente arquivado ou canal revogado devolve 404.
- `GET /api/v1/tenants/:tenantId/conversations`: owner/admin/manager/staff. Paginação por UUID `after`, 50 itens. Ordem estável por ID, não ranking de atividade.
- `GET /api/v1/tenants/:tenantId/conversations/:id/messages`: mesmos papéis; ordem cronológica com desempate por UUID e cursor `after`, 50 itens. Cursor de outra conversa rejeitado.

## Invariantes

Transaction tenant-scoped com lock do tenant (herdado de TenantService). As verificações de sessão/membership e as escritas usam a mesma transação. Conversa única por cliente/canal nesta etapa; modo inicial AI_PAUSED. Evento e mensagem são append-only para a credencial runtime. FKs compostas impedem associações cross-tenant. RLS forçada nas três tabelas. Dedupe global provider+external_event_id, com chave mock prefixada pelo canal gerado no servidor. Conflito de hash grava auditoria sem conteúdo e devolve 409 após commit. Nenhuma chamada LLM ou provider dentro da transação.

Schema version 6 obrigatória. Aplicar migrations com a credencial de migration antes de iniciar código novo; não apagar histórico no rollback. Testes HTTP/DB adicionados à suite existente: repetição concorrente, conflito de payload, IDOR, canal revogado, histórico, cursor inválido, RLS e auditoria.

## Pendências preservadas

Este endpoint é uma ferramenta de simulação síncrona, não o ingress de produção. O caminho real ainda exige assinatura raw-body, resolução verificada de canal, outbox durável, queue/worker, locks renováveis por conversa, retries/debounce, status callbacks e media. A serialização atual por tenant é deliberadamente conservadora para testes e não é a estratégia de escala final. Interface de conversas/canais, ciclo de encerramento/reabertura, campos restantes da especificação, handoff e outbound continuam pendentes. Não marcar Phase 4 concluída ou ativar produção.
