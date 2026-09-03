# ADR-033 — API de armazenamento outbound de sandbox

Estado: aceite, sem consumidor/envio.

POST `/api/v1/tenants/:tenantId/conversations/:id/mock-outbound-intents` aceita apenas `requestId` UUID e `text`. Reutiliza a aceitação do ADR-032. Responde HTTP 200 tanto para novo armazenamento como replay, com `intentId`, `duplicate` e `state: stored`. Não responde 202 porque ainda não existe processamento assíncrono desta intenção. Campos adicionais são recusados, incluindo tenant/conversa no corpo. O tenant do caminho é um seletor sujeito a autorização, nunca uma fonte de confiança.

GET `/api/v1/tenants/:tenantId/outbound-intents/:id` devolve apenas `intentId` e `state: stored`. Owner/admin da empresa podem consultar recibos de outros operadores, mas não recebem texto, ator, telefone ou credenciais. As respostas e erros usam no-store e ID de correlação existentes. Sem efeito colateral de envio no GET.

Autenticação e autorização são verificadas em ambas as rotas. 400 representa validação, 401 falta de autenticação, 403 papel insuficiente, 404 recurso/tenant inacessível ou destino inelegível, 409 conflito de replay/capacidade. Erros são sanitizados. Após resposta incerta, repetir exatamente o mesmo POST com a mesma chave, empresa e utilizador; não gerar nova chave automaticamente. O GET permite consultar quando o ID servidor é conhecido.

OpenAPI inclui DTOs de pedido/recibo/erro, operationIds estáveis e semântica de armazenamento. Testes HTTP cobrem autenticação, papéis, isolamento, corpo extra/inválido, concorrência, conflito, consulta mínima e headers. Schema permanece 16.

Não há worker, dispatcher, envio Meta, UI, estado de entrega, rate limit dedicado por rota ou política de retenção concluída. O teto existente limita a 1000 intenções por tenant, mas não é um limite de taxa. Esta API é de sandbox e não torna o produto pronto para produção. Sem merge/deploy ou ativação de canais reais.
