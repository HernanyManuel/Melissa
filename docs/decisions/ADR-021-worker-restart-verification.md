# ADR-021 — Verificação de recuperação após morte do worker

Estado: teste de integração da Phase 4; sem alteração do comportamento do produto.

## Cenário

Na base PostgreSQL/Redis descartável da CI, o teste cria utilizador, tenant, cliente e canal mock através da API real. Arranca um processo worker real, espera readiness e termina esse processo com SIGKILL. Só sinaliza o processo filho que criou, nunca um PID externo.

Com o worker terminado, a API aceita uma mensagem com HTTP 202. Após mais de um ciclo de dispatch, o recibo continua pending e o conteúdo permanece na outbox PostgreSQL. Um novo processo recupera o evento, cria a mensagem e limpa o payload. Após outro reinício e replay HTTP, o ID do evento mantém-se e existe uma única mensagem e uma única auditoria de receção.

## Execução

Após build e migrations, sem outro consumidor em execução:

```sh
NODE_ENV=test RUN_WORKER_RESTART_TEST=true node --test apps/backend/dist/test/worker-restart.integration.test.js
```

Exige configuração da DB/Redis de testes, papel runtime com RLS e porta 3002 livre. A CI espera a saída do worker da suite anterior antes de executar o cenário. Limite total de 60 segundos, requests com timeout e limpeza do processo filho no finally. Não executar contra dados de produção.

## Limites

Prova recuperação de backlog aceite durante indisponibilidade do worker e idempotência após reinício real. Não simula morte entre commit SQL e ACK BullMQ, job em processamento com lease ativo, perda/restart Redis, failover PostgreSQL nem corte de rede. Esses cenários continuam pendentes; não confundir este teste com cobertura completa de disaster recovery. Não altera frontend, schema, contratos, credenciais ou políticas de retenção. Sem merge/deploy.
