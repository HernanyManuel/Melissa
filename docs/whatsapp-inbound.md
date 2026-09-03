# WhatsApp inbound — estado atual (schema 14)

Fluxo implementado: bytes assinados → normalização → routing verificado → persistência por tenant. GET/POST `/webhooks/whatsapp` existem, mas estão desativados por defeito e não foram expostos à Internet. Não existe provisioning real ou envio WhatsApp; não configurar Meta para tráfego real ainda.

## Ativação local explícita

Configurar WHATSAPP_WEBHOOK_ENABLED=true, WHATSAPP_INTEGRATION_KEY, WHATSAPP_APP_SECRET e WHATSAPP_VERIFY_TOKEN apenas no servidor. Secrets/token devem ter pelo menos 16 caracteres. Sem flag, retorna 404; configuração incompleta impede arranque. WHATSAPP_WEBHOOK_RATE_LIMIT controla o teto por integração/minuto (default 300). Bindings têm de vir de provisioning confiável, não de IDs enviados pelo frontend. Ver [ADR-016](decisions/ADR-016-whatsapp-http-gate.md).

## Texto

WhatsAppIngress recebe apenas bytes e assinatura; a integração/secret são configuração server-side. Resolve canal live ativo por integração/WABA/phone, deduplica por canal/message_id e resolve ou cadastra cliente pelo telefone. Clientes arquivados não são reativados; consentimentos não são inferidos. Evento, cliente novo, lote, outbox, envelope e auditoria são transacionais. O worker revalida binding/canal/cliente e grava a mensagem. Ver [ADR-013](decisions/ADR-013-external-inbound-outbox.md) e [ADR-014](decisions/ADR-014-inbound-customer-resolution.md).

## Estados de entrega

sent/delivered/read/failed são registados num histórico imutável por tenant/canal/message_id com ocorrido_em e recebido_em. Repetições idênticas devolvem o mesmo recibo; destinatário divergente gera conflito auditado. Não criam clientes ou mensagens e não atualizam mensagens inbound. A correlação com envios e o estado agregado da UI permanecem pendentes. Ver [ADR-015](decisions/ADR-015-whatsapp-status-journal.md).

## Contrato e limites de transporte

O adapter valida HMAC-SHA256 sobre os bytes originais antes de UTF-8/JSON. verifyChallenge valida modo subscribe, token e challenge escalar numérico. Limites: corpo 256 KiB, 20 entradas, 100 alterações por entrada e 100 mensagens/statuses por alteração. Campos desconhecidos são descartados pela normalização; tipos de evento não suportados são contados.

Media e estados desconhecidos com canal verificável podem ir para quarentena cifrada se WHATSAPP_QUARANTINE_KEY (32 bytes base64) e WHATSAPP_QUARANTINE_KEY_ID estiverem configurados. Sem chave ou sem âmbito seguro, continuam recusados. O payload individual é preservado, não o request multi-tenant inteiro. Ver [ADR-017](decisions/ADR-017-encrypted-whatsapp-quarantine.md) para cifra/limites. O worker já purga payloads expirados, preservando ledger/auditoria: [ADR-018](decisions/ADR-018-quarantine-retention-worker.md). Revisão/reprocessamento, alertas e gestão de chaves continuam pendentes. Não há download nem processamento de media.

Os commits são por evento: erro posterior pode deixar anteriores persistidos; repetir o pedido é seguro pela deduplicação. O controller só confirma com 200 depois dos commits. O ACK não inclui recibos ou IDs de tenant. Ver ADR-016 para erros e limites.

## Antes de expor o webhook

Consulta operacional: GET `/api/v1/tenants/:tenantId/quarantine` e página Flutter `/quarantine/:tenantId`, acessível pela conta para owner/admin. Mostra apenas canal, ID, datas e contadores, com páginas de 50 e cursor `after`; nunca conteúdo cifrado ou chaves. Ver [ADR-019](decisions/ADR-019-quarantine-metadata-operations.md). Consulta de metadados não equivale a revisão/reprocessamento do conteúdo.

Ainda implementar provisioning Meta verificado, tratamento durável de eventos não suportados e proteção no proxy. Controller, limites e testes HTTP já existem, mas não equivalem a validação Meta real. Separar credenciais de ingress/provisioning antes de produção. Uma assinatura válida não substitui o binding autorizado do [ADR-012](decisions/ADR-012-whatsapp-routing.md).

Pendentes: media, campos adicionais/erros detalhados dos callbacks, identificadores não telefónicos, outbound, reconciliação de estados, gestão/evidência de consentimentos, retenção, UI de entrega e integração Meta real.

Credenciais futuras: WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN e access token server-side. Testes usam valores sintéticos. Nunca enviar secrets ao Flutter, logs ou Git.

## Verificação

Suites unitárias/integradas cobrem assinatura, challenge, Unicode, payloads inválidos, routing, concorrência, clientes, outbox/worker, revogação, histórico de estados e RLS. Estado da execução integral nos checks do PR #5.

Referências do protocolo: [endpoint Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/), [messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages) e [texto](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text).
