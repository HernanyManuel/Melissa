# ADR-016 — Endpoint HTTP WhatsApp opt-in

Estado: implementado e desativado por defeito; apenas desenvolvimento/teste.

## Contrato

GET/POST `/webhooks/whatsapp`, sem sessão JWT: a autenticação do fornecedor é a assinatura/token, não um utilizador. A flag WHATSAPP_WEBHOOK_ENABLED tem de ser a string true. Sem ela, ambos devolvem 404. Ativação exige integration key, app secret e verify token server-side; configurações incompletas impedem o arranque. NODE_ENV=production continua bloqueado pela aplicação.

GET valida mode/token/challenge e devolve challenge em texto com 200. POST exige application/json sem compressão, até 256 KiB, lido como Buffer por middleware antes do parser JSON. O adapter verifica os bytes originais antes de interpretar o conteúdo. Duplicação de headers de assinatura não produz uma assinatura válida. Nenhum ID de tenant/recibo é devolvido no ACK.

POST devolve 200 EVENT_RECEIVED apenas depois de concluir os commits do ingresso (ou reconhecer duplicados duráveis). Não espera pela conclusão do worker. Pedidos com eventos múltiplos mantêm commits por evento; falha posterior pode exigir replay, protegido por dedupe.

403: assinatura/token inválido. 400: payload inválido. 413: corpo excessivo. 415: formato/compressão não suportados. 429: limite. 503: rota indisponível, tipo não suportado, cliente arquivado, conflito, ausência de eventos ou falha de dependência/persistência. Não há ACK de sucesso quando se perde conteúdo. A resposta global omite detalhes, secrets e conteúdo. Logs existentes não incluem URL/query/body/headers.

## Limitação e disponibilidade

Contador Redis atómico por integração, janela de 60 segundos iniciada pelo primeiro pedido, default 300 pedidos. Conta GET/POST válidos e inválidos; não confia em X-Forwarded-For. Redis indisponível provoca 503. Trata-se de teto global conservador de desenvolvimento, não fairness por tenant nem proteção suficiente contra DDoS. Acrescentar limites no proxy e separar tráfego validado antes de produção.

## Testes e limites

HTTP real em loopback com PostgreSQL/Redis: default 404, challenge, token duplicado/errado, bytes adulterados, JSON inválido, tipo/compressão/tamanho, ACK após outbox, replay, rota/tipo recusados, limite e Redis indisponível. Fixture cria bindings sintéticos com credencial de migration; runtime nunca provisiona ligações.

Não foram criados secrets/bindings reais nem feita configuração Meta, exposição à Internet, merge ou deploy. Provisioning verificado, quarentena de media/tipos não suportados, proteção operacional e validação Meta real continuam pendentes. 503 para tipos não suportados pode provocar retries repetidos: não ativar para tráfego real antes de resolver essa pendência. Correlação outbound/UI permanecem fora desta entrega.

Protocolo GET consultado na [documentação Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/).
