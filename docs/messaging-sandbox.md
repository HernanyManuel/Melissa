# Conversas e mensagens — persistência de teste

## Entrada assíncrona (schema 8)

`POST .../channels/:id/mock-inbound` passa a devolver **202** com `{ duplicate, eventId }`, não uma mensagem imediata. Repetir o evento devolve o mesmo recibo; conteúdo divergente continua a devolver 409. Consultar `GET /api/v1/tenants/:tenantId/message-receipts/:eventId`: `{ eventId, state, message }`, com estados pending/processed/rejected/failed e message nula enquanto não processada. Endpoint protegido por messages:read; recibos alheios devolvem 404. Recibos anteriores à migration, sem envelope, mantêm state processed.

O worker consome incoming-messages via BullMQ. O HTTP confirma evento/outbox/envelope e lote no PostgreSQL; depois do debounce o dispatcher publica o ID na fila e o worker cria conversa/mensagem. Ver [ADR-010](decisions/ADR-010-inbound-outbox.md) para limites e autorização e [ADR-011](decisions/ADR-011-conversation-lock-batching.md) para lock/batching. Executar migration antes de reiniciar API/worker; readiness exige schema 8.

`MESSAGE_DEBOUNCE_MS` define a janela de silêncio (100–2000 ms, default 1500), limitada a cinco segundos e 50 eventos por lote. Eventos duplicados não adiam o prazo. Mensagens mantêm o texto original e um `batchId` opcional; não são concatenadas. O fecho do lote não significa que todos os envelopes terminaram. Ainda não existem WhatsApp real, outbound ou consumidor IA.

Entrega parcial da Phase 4 (§§16–18). Não é webhook WhatsApp nem motor de IA. Usa apenas canais mock e clientes existentes. Nenhum envio externo.

## Contrato

- `POST /api/v1/tenants/:tenantId/channels/:id/mock-inbound`: owner/admin; corpo `customerId` UUID, `eventId` UUID estável e `text` de 1–4096 caracteres. Retorna 202 com `duplicate` e `eventId`, também para repetição idêntica; 409 se o mesmo evento tiver outro conteúdo. Os IDs de cliente/canal têm de pertencer ao tenant autenticado; cliente arquivado ou canal revogado devolve 404.
- `GET /api/v1/tenants/:tenantId/conversations`: owner/admin/manager/staff. Paginação por UUID `after`, 50 itens. Ordem estável por ID, não ranking de atividade.
- `GET /api/v1/tenants/:tenantId/conversations/:id/messages`: mesmos papéis; ordem cronológica com desempate por UUID e cursor `after`, 50 itens. Cursor de outra conversa rejeitado.

## Invariantes

Transaction tenant-scoped com lock do tenant (herdado de TenantService). As verificações de sessão/membership e as escritas usam a mesma transação. Conversa única por cliente/canal nesta etapa; modo inicial AI_PAUSED. Evento e mensagem são append-only para a credencial runtime. FKs compostas impedem associações cross-tenant. RLS forçada nas três tabelas. Dedupe global provider+external_event_id, com chave mock prefixada pelo canal gerado no servidor. Conflito de hash grava auditoria sem conteúdo e devolve 409 após commit. Nenhuma chamada LLM ou provider dentro da transação.

Schema version 8 obrigatória. Aplicar migrations com a credencial de migration antes de iniciar código novo; não apagar histórico no rollback. Testes HTTP/DB: repetição concorrente, conflito de payload, IDOR, canal revogado, histórico, cursor inválido, RLS, auditoria e lotes duráveis.

## Pendências preservadas

Este endpoint é uma ferramenta de simulação assíncrona, não o ingress de produção. O caminho real ainda exige assinatura raw-body, resolução verificada de canal, status callbacks e media. A serialização SQL por tenant é deliberadamente conservadora e não é a estratégia de escala final. Gestão visual de canais, ciclo de encerramento/reabertura, campos restantes da especificação, handoff e outbound continuam pendentes. Não marcar Phase 4 concluída ou ativar produção.
