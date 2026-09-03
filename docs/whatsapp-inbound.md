# WhatsApp inbound — estado atual (schema 12)

Fluxo interno implementado: bytes assinados → normalização → routing verificado → persistência por tenant. Não existe controller HTTP, provisioning real ou envio WhatsApp; não configurar Meta para esta aplicação ainda.

## Texto

WhatsAppIngress recebe apenas bytes e assinatura; a integração/secret são configuração server-side. Resolve canal live ativo por integração/WABA/phone, deduplica por canal/message_id e resolve ou cadastra cliente pelo telefone. Clientes arquivados não são reativados; consentimentos não são inferidos. Evento, cliente novo, lote, outbox, envelope e auditoria são transacionais. O worker revalida binding/canal/cliente e grava a mensagem. Ver [ADR-013](decisions/ADR-013-external-inbound-outbox.md) e [ADR-014](decisions/ADR-014-inbound-customer-resolution.md).

## Estados de entrega

sent/delivered/read/failed são registados num histórico imutável por tenant/canal/message_id com ocorrido_em e recebido_em. Repetições idênticas devolvem o mesmo recibo; destinatário divergente gera conflito auditado. Não criam clientes ou mensagens e não atualizam mensagens inbound. A correlação com envios e o estado agregado da UI permanecem pendentes. Ver [ADR-015](decisions/ADR-015-whatsapp-status-journal.md).

## Contrato e limites de transporte

O adapter valida HMAC-SHA256 sobre os bytes originais antes de UTF-8/JSON. verifyChallenge valida modo subscribe, token e challenge escalar numérico. Limites: corpo 256 KiB, 20 entradas, 100 alterações por entrada e 100 mensagens/statuses por alteração. Campos desconhecidos são descartados pela normalização; tipos de evento não suportados são contados.

Media e eventos desconhecidos recusam o pedido antes de escrita. Os commits dos eventos suportados são por evento: erro posterior pode deixar anteriores persistidos; repetir o pedido é seguro pela deduplicação. Não há confirmação HTTP neste serviço. Recibos internos só são devolvidos após commit.

## Antes de expor o webhook

Implementar controller raw-body/limites, rate limiting, configuração de secrets, provisioning Meta verificado, tratamento durável de eventos não suportados e testes HTTP/isolamento. Separar credenciais de ingress/provisioning antes de produção. Uma assinatura válida não substitui o binding autorizado do [ADR-012](decisions/ADR-012-whatsapp-routing.md).

Pendentes: media, campos adicionais/erros detalhados dos callbacks, identificadores não telefónicos, outbound, reconciliação de estados, gestão/evidência de consentimentos, retenção, UI de entrega e integração Meta real.

Credenciais futuras: WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN e access token server-side. Testes usam valores sintéticos. Nunca enviar secrets ao Flutter, logs ou Git.

## Verificação

Suites unitárias/integradas cobrem assinatura, challenge, Unicode, payloads inválidos, routing, concorrência, clientes, outbox/worker, revogação, histórico de estados e RLS. Estado da execução integral nos checks do PR #5.

Referências do protocolo: [endpoint Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/), [messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages) e [texto](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text).
