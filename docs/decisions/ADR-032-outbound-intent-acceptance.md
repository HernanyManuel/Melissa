# ADR-032 — Aceitação interna de intenções mock

Estado: aceite, incremento interno sem endpoint ou envio.

`OutboundIntentService.acceptMock` usa a sessão e o contexto autorizado do `TenantService`. A permissão de sandbox `channels:manage` limita a owner/admin; não define ainda as permissões de handoff/envio humano. O lock de tenant serializa aceitação, alterações de membership, canal e cliente, e o limite de 1000 intenções por empresa. Não há chamada ao provider.

Pedidos novos exigem conversa do tenant não encerrada/arquivada, cliente não arquivado e canal WhatsApp mock ativo. IDs são UUIDs; texto preservado exatamente, com máximo de 4096 pontos de código, sem vazio/whitespace, NUL ou surrogate inválido. Intenção e auditoria são gravadas na mesma transação; falha da auditoria desfaz a intenção. Apenas identificadores, nunca conteúdo/telefone, entram na auditoria ou resposta.

Replay é por tenant/ator/requestId, depois de revalidar a autorização atual. Conteúdo e conversa idênticos devolvem o mesmo UUID servidor com `duplicate: true` e `state: stored`, mesmo se o canal entretanto foi desligado. Isto é consulta da aceitação passada, não um novo envio. Mudança de conteúdo/conversa produz conflito e auditoria confirmada antes de lançar o erro. Replay não consome quota adicional nem duplica a auditoria de aceitação. Uma sessão revogada ou papel sem permissão não obtém replay.

O teto de 1000 registos é uma proteção temporária de armazenamento do sandbox, não entitlements nem retenção concluída. A quota não é configurável pelo cliente. O futuro consumidor deve revalidar canal, cliente e autorização antes do envio. API/OpenAPI, UI, dispatch, política de destinatário, correlação de mensagens, retries e adapter live continuam pendentes. Não há mensagem nem job criado por este serviço; `stored` nunca significa queued/sent/delivered.

Testes com PostgreSQL: concorrência, conflito auditado, preservação do texto, respostas mínimas, RBAC, sessão inválida, membership inativa, tenant errado, elegibilidade, replay após revogação, quota e rollback por falha de auditoria. Schema permanece 16; sem merge/deploy.
