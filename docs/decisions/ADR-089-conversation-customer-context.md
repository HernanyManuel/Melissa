# ADR-089 — Painel de contexto do cliente na conversa

## Estado

Fatia incremental da Phase 8 no PR draft #7, sem merge nem deploy.

## Decisão

- Endpoint de consulta `GET /api/v1/tenants/:tenantId/conversations/:id/customer`, protegido por sessão, membership e permissão `customers:read`. A consulta parte da conversa da tenant autorizada, e recusa com 404 conversas inacessíveis e clientes arquivados.
- Resposta `{item}` com projeção restrita aos campos `id`, `displayName`, `phoneE164`, `email`, `language`, `notes`, `marketingConsentStatus` e `whatsappOptInStatus`. Não devolve estado interno da conversa, credenciais Meta, `deletedAt`, tokens ou dados de outro tenant.
- Widget Flutter expansível de **leitura apenas**, apresentado junto das notas privadas. A informação é obtida do endpoint específico da conversa, sem procurar a lista global de clientes e sem pedidos de envio. Falhas apagam o painel e oferecem uma nova consulta explícita. Mudanças de conversa/tenant invalidam a resposta anterior.
- Traduções para pt, en, es, fr, it e de. A presença do painel não altera o fluxo de takeover, confirmação manual, receção de mensagens ou marcação como lida.
- Testes: integração HTTP verifica isolamento entre tenants, visibilidade do cliente correto e lista restrita de campos; widget Flutter verifica dados exibidos e ausência de POST /messages.

## Limites

O painel apresenta apenas os campos do registo atual do cliente, não reservas anteriores, estatísticas, consentimento legal detalhado, histórico omnicanal ou edição do perfil. As notas deste registo podem conter dados pessoais; não expor em alertas ou logs. A permissão `customers:read` é intencionalmente distinta de `messages:read`, pelo que um operador que só consiga ler conversas pode receber 403 ao abrir o painel. A limpeza de dados e políticas de retenção continuam a seguir os mecanismos próprios de clientes.
