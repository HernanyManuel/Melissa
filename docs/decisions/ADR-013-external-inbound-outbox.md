# ADR-013 — Origem externa e outbox WhatsApp

Estado: implementado para testes internos com texto e clientes existentes; sem endpoint HTTP.

Migration 10 distingue `origin=mock` (actor_id obrigatório, sem integration_key) de `origin=whatsapp` (actor_id nulo, integration_key obrigatório). Auditoria distingue actor_type user/whatsapp com constraints equivalentes. Defaults preservam os registos anteriores; não é criado utilizador fictício. RLS e grants existentes não são alargados.

`WhatsAppIngress.receive` compõe verificação da assinatura sobre bytes originais, normalização e routing verificado, sem aceitar tenant/customer IDs externos. Rejeita media/status desconhecidos antes de escrever. Cada mensagem de texto obtém tenant/canal via registo confiável, resolve cliente ativo pelo telefone E.164 e grava evento, outbox, lote, envelope e auditoria na mesma transação. Usa o mesmo helper de batching do mock. Deduplicação provider+canal+message_id; divergência de remetente/timestamp/texto produz conflito auditado sem conteúdo.

Os commits são por mensagem, não por request multi-tenant: um erro numa mensagem posterior pode deixar anteriores aceites. Retry completo é seguro pela deduplicação. Recibos retornam apenas após commit. Timestamp externo fica no evento/mensagem; batching usa hora de receção. Timestamps futuros além de cinco minutos são rejeitados.

O dispatcher transporta apenas UUID, como antes. O nome interno do job `mock-inbound` é mantido por compatibilidade nesta transição; a origem vem exclusivamente da DB. O worker revalida bindings da integração e canal live ativo antes de persistir eventos WhatsApp. Para mock mantém membership e permissão channels:manage. Revogação de canal/binding ou arquivo do cliente provoca rejected e limpeza do payload. Auditoria externa não atribui ações a pessoas.

## Limites

Sem controller público, confirmação Meta, provisionamento real, novos clientes automáticos, media/status, outbound, IA ou deploy. Clientes desconhecidos/arquivados são recusados; não se infere consentimento. Não ligar um webhook real enquanto estes casos não tiverem tratamento durável e testes HTTP. Identificadores de remetente não telefónicos ainda não são suportados. Não implementar fallback silencioso.

O runtime continua partilhado entre API/worker; separação de credenciais e provisioning confiável do ADR-012 continuam requisitos de produção. Não há teste de crash físico/Redis failover nesta entrega.

## Verificação

Integração com assinatura sintética, PostgreSQL e worker separado: recibos concorrentes idênticos, conflito auditado, remetente desconhecido, media recusada, null actor com origem explícita, constraint contra troca de origem, persistência única, timestamp, limpeza do payload e revogação entre receção e consumo. Regressões mock existentes continuam obrigatórias.
