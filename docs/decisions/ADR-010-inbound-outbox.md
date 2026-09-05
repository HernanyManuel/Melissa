# ADR-010 — Outbox inbound e envelope de encaminhamento

Estado: implementado para simulação mock, antes de WhatsApp live.

## Decisão

O HTTP autentica e valida, grava external_event, inbound_outbox e inbound_dispatch atomicamente, e responde 202 com eventId. Não contacta Redis. O dispatcher procura até 50 envelopes devidos por ciclo de um segundo e adiciona jobs BullMQ contendo apenas UUID. O worker resolve tenant a partir desse envelope persistido, nunca de um tenant fornecido pelo job.

Payload fica em inbound_outbox com RLS forçada e FKs compostas para evento, cliente e canal. inbound_dispatch é a exceção explícita: SELECT global para a credencial interna, apenas UUID de trabalho/tenant, estado, tentativas e data de retry. Não contém conteúdo, telefone, cliente ou secrets. INSERT/UPDATE exigem contexto tenant; UPDATE não permite alterar os identificadores. Não existe endpoint público de listagem global. Não usar uma GUC como autorização para desativar RLS.

O worker serializa pelo lock de tenant existente, bloqueia o envelope e revalida membership atual do autor, canal mock ativo e cliente não arquivado. Logout/expiração da sessão não cancela trabalho já aceite; revogação da membership/papel impede processamento. A futura integração live terá identidade de serviço própria, não este autor de simulação.

Mensagem, conversa, processed_at, auditoria e estado processed confirmam na mesma transação. Duplicados de entrega depois do commit tornam-se no-op. Payload da outbox é limpo após processamento ou rejeição; o histórico autorizado permanece. Jobs podem chegar fora de ordem; datas do evento são preservadas e lastMessageAt nunca recua.

## Falhas

Redis indisponível não invalida HTTP já confirmado. O dispatcher volta a tentar usando PostgreSQL como fonte de verdade. Jobs concluídos/falhados são removidos do Redis; o envelope durável controla retries de processamento (máximo 5, backoff 2/4/8/16 segundos). Falhas definitivas permanecem em estado failed, incluindo payload protegido para futura inspeção/retenção. BullMQ renova o lock do job e recupera jobs stalled; isto não substitui o futuro lock de conversa/debounce.

Se a DB cair durante uma tentativa, pode não ser possível registar a tentativa; o trabalho permanece recuperável e não se afirma exactly-once no transporte. Os efeitos transacionais são idempotentes. Não existe chamada a provider externo neste worker.

## Limites

Envelope mínimo tem visibilidade cross-tenant apenas interna; separar credenciais API/dispatcher/worker é reforço futuro antes de produção. Lock por tenant é conservador e limita paralelismo; ainda falta lock renovável por conversa. Painel de failed jobs, retry/discard autorizado, quotas, circuit breakers, métricas completas, teste de queda real de Redis e kill/restart de worker continuam pendentes. Os testes atuais demonstram backlog com fila pausada, retoma, entrega repetida, revogação antes do consumo e orçamento de tentativas.
