# ADR-050 — Worker de ingestão media opt-in

## Estado

Aceite em 2026-09-05.

## Decisão

O worker de ingestão só arranca com `MEDIA_INGESTION_WORKER_ENABLED=true`. O arranque falha se o transporte WhatsApp media, storage S3, keyring atual ou malware scanner não estiverem simultaneamente configurados. Não existe fallback para mocks.

O PostgreSQL continua a ser a fonte de verdade. Um dispatcher lê até 25 envelopes elegíveis por ciclo e publica jobs BullMQ contendo exatamente `{id, attempt}`. Tenant, ID Meta, MIME, URL, payload e credenciais nunca entram no Redis. O processador volta a resolver e validar todo o contexto persistido.

Jobs usam identidade `id-attempt`, uma tentativa BullMQ e são removidos depois da execução. Falhas duráveis são controladas pelo schema 20; o envelope define backoff e o dispatcher volta a publicar quando elegível. Concorrência é limitada a dois downloads para reduzir pressão sobre provider e memória.

O shutdown deixa de descobrir trabalho, aguarda o ciclo ativo e fecha worker/queue antes das dependências partilhadas.

## Limites

- A integração CI usa source/storage injetados e Redis/PostgreSQL reais; nenhuma chamada Meta/S3 real é executada.
- A ativação num ambiente externo exige validação do bucket, credenciais mínimas, hosts Meta e teste de recuperação.
- Malware scanning, magic bytes, quotas por tenant e limpeza do objeto continuam pendentes.
