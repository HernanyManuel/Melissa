# ADR-062 — Outbox automática com proveniência própria

- Estado: aceite
- Data: 2026-09-08

## Contexto

A outbox existente foi criada para ações humanas no sandbox: exige membership/actor e provider mock. Usá-la para IA falsificaria autoria. Separar `finish` e criação do outbound, por outro lado, abriria uma janela em que usage fica concluído mas a resposta se perde definitivamente num retry.

## Decisão

O schema 23 cria `ai_outbound_intents`, tenant-scoped e imutável, e `ai_outbound_dispatch`, envelope global mínimo sem conteúdo. Cada intent pertence exatamente a um `ai_turn`, conversation, customer e channel por FKs compostas; `(tenant_id, turn_id)` é único.

Para conclusão live, `PrismaAITurnLedgerRepository.finish` bloqueia turno e conversation, revalida `AI_ACTIVE` e o `mode_epoch`, e na mesma transação:

1. finaliza o turno;
2. insere usage append-only;
3. grava a resposta automática;
4. cria o envelope de dispatch.

Se o modo/epoch mudou, finaliza como `stale`, preserva usage e não cria outbound. Sandbox e outcomes sem texto continuam sem intent. A role runtime não pode alterar nem apagar o conteúdo.

## Consequências

- Nenhum texto autorizado é devolvido pelo coordenador antes do commit da outbox.
- Takeover concorrente vence o envio automático no fence transacional final.
- O dispatcher pode descobrir apenas ID/tenant/state; conteúdo permanece sob RLS.
- Ainda não há consumidor desta outbox nem envio live. Retenção, retries e recibos serão adicionados com o worker/adapters.
