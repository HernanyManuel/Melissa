# ADR-015 — Histórico durável de estados WhatsApp

Estado: implementado no ingresso interno, sem endpoint público ou envio.

## Decisão

Callbacks sent/delivered/read/failed passam pela mesma assinatura e resolução de canal ativo que as mensagens. Cada callback é persistido em external_events (provider whatsapp-status) e whatsapp_status_events com auditoria na mesma transação. Não cria cliente, conversa, mensagem nem job inbound.

Chave idempotente: hash de canal, message_id externo, estado e timestamp. Repetição idêntica devolve o mesmo recibo; destinatário divergente para a mesma chave gera conflito auditado, sem alterar o primeiro registo. Namespace separado evita colisões com IDs de mensagens recebidas.

Migration 12 aplica RLS forçada e FKs compostas por tenant. Runtime tem apenas SELECT/INSERT no histórico. Guarda ocorrido_em e recebido_em separadamente. Eventos fora de ordem são preservados; não se calcula “estado atual” pela última chegada.

O histórico aceita message_id ainda não conhecido localmente, pois o callback pode chegar antes da confirmação de um envio futuro. Não inventa uma mensagem outbound nem atualiza mensagens inbound. processedAt significa que o callback foi registado, não que um envio foi conciliado.

## Limites

Correlação com outgoing messages, estado agregado monotónico, reconciliação e UI de entrega dependem do módulo outbound, ainda não implementado. Detalhes de erro, pricing e conversation metadata do fornecedor ainda não são guardados; só os campos normalizados do adapter. Retenção/eliminação e política para estados desconhecidos continuam pendentes. Media/tipos desconhecidos recusam o pedido antes de qualquer escrita; não há ACK HTTP.

Callbacks preservam dados externos não confiáveis: assinatura e binding autorizam receção, não comprovam identidade do destinatário ou sucesso do produto. Não usar este histórico para conceder consentimento ou permissões.

## Testes

Assinatura inválida, duplicados concorrentes, ordem read/delivered/sent, estado failed, destinatário conflitante, estado desconhecido, ausência de cadastro/outbox/mensagem, auditoria, leitura cross-tenant negada e proibição runtime de alteração/eliminação. Aplicar migration 12 antes de iniciar API/worker.
