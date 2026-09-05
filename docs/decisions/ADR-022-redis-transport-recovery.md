# ADR-022 — Recuperação da ligação Redis do worker

Estado: teste de integração da Phase 4; sem mudança no produto.

## Cenário

O cenário de reinício passa a encaminhar todas as ligações Redis do worker filho por um proxy TCP local, exclusivo do teste. O proxy apenas transporta bytes: não interpreta nem regista conteúdo ou credenciais. Aceita apenas Redis de testes em localhost/127.0.0.1, sem TLS, e escuta numa porta loopback efémera.

Após os testes de reinício existentes, corta sockets estabelecidos e recusa novas ligações do worker. Verifica readiness 503 e liveness 200. A API mantém a ligação direta ao Redis; aceita uma nova mensagem mock com HTTP 202. Depois de várias oportunidades de dispatch, o recibo continua pending, não existe mensagem e o payload permanece no PostgreSQL.

Ao restabelecer o transporte, o mesmo processo worker volta a ficar pronto e recupera o backlog. Verifica uma única mensagem, auditoria única, limpeza do payload e replay idempotente. A limpeza termina apenas o worker filho e fecha o proxy/socket criados pelo teste.

## Execução e limites

Executado no passo CI `Worker restart and Redis transport recovery`, com a configuração descartável e comando do ADR-021. Exige ausência de outro consumidor; CI aguarda a saída da suite anterior.

Prova perda/restabelecimento real de sockets do worker, não apenas Queue.pause. Não prova crash/restart do servidor Redis, perda dos dados Redis, falha global da API, corte durante uma transação ativa, expiração de lease em processamento, TLS, failover ou recuperação de backups. A API não perde Redis neste cenário: não se deve inferir que o ingresso autenticado funciona numa falha global. Sem novas credenciais, migration, frontend, merge ou deploy.

Lint local aprovado. O cliente Prisma local está desatualizado; types/migrations/testes completos são verificados na CI após geração. Resultados nos checks do PR #5.
