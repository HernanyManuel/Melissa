# ADR-094 — Checkpoints SSE duráveis por operador e tenant

## Estado

Aceite como fatia incremental da Phase 8 no PR draft #7. Implementação funcional validada no commit `ef7a3149f0fd217754e488b85e0cf9f588308b1e`, workflow [38168100442](https://github.com/HernanyManuel/Melissa/actions/runs/38168100442) integralmente verde (backend, Flutter e Compose). Não houve merge, deploy nem ativação do WhatsApp live.

## Contexto

A ADR-080 disponibilizou SSE durável com `after`/`Last-Event-ID`, mas o Flutter conservava o cursor apenas em memória. Um reload voltava ao início da sequência do tenant, aumentando o replay de eventos antigos e atrasando a sincronização. O cursor de leitura da ADR-085 regista uma ação explícita do operador por conversa; **não** é apropriado reutilizá-lo como checkpoint do stream.

O cliente recebe eventos SSE com identificadores mínimos e consulta os conteúdos apenas através de REST autorizado. Persistir o último SSE **recebido**, sem esperar pela aplicação dos dados REST, permitiria perder eventos num reload ocorrido durante uma falha de rede.

## Decisão

- Migração **62** cria `inbox_stream_checkpoints`, tabela com chave `(tenant_id, actor_id)`, `last_applied_sequence` e `updated_at`. Possui FK para a membership e para um evento de `inbox_events` no mesmo tenant; aplica `FORCE ROW LEVEL SECURITY` e uma política explícita que obriga a correspondência de ambos os contextos (`app.tenant_id`, `app.actor_id`). A role runtime só pode ler, inserir e atualizar as colunas estritamente necessárias. O readiness exige `schema_version=62`.
- `GET /api/v1/tenants/:tenantId/inbox/checkpoint` obtém `{after: null|string}` do operador autenticado, exigindo `messages:read`. `POST` com `{after: "42"}` só aceita uma sequência positiva até ao limite de BIGINT que **exista naquele tenant**; recusa valores inválidos (400) e IDs não existentes (409). A atualização é monotónica, idempotente e serializada pelo lock de tenant de `TenantService.scoped`. Nenhum destes endpoints aceita `actorId` indicado pelo cliente.
- O Flutter autentica, recupera o checkpoint e só então inicia a listagem REST e o SSE `after` correspondente. Se a recuperação tiver erro transitório, começa o replay em 0; se indicar falta de autorização, limpa o estado e não apresenta dados de um tenant anterior.
- Eventos SSE recebidos continuam a atualizar imediatamente o cursor **em memória**, para reconexão dentro da sessão. O checkpoint **durável** só é enviado após a aplicação bem-sucedida da atualização REST que cobre o lote de conversas afetadas. Novos eventos surgidos durante essa atualização aguardam o próximo lote. Se o REST falhar, os IDs e a sequência pendentes são reintroduzidos para retry. Se a escrita do checkpoint falhar, o reload fará replay a partir de uma posição anterior segura; nunca se marca como lida.
- A mudança de tenant, remoção do widget ou revogação invalida as gerações e limpa os cursores/IDs locais. A persistência fica no servidor, isolada pelo utilizador autenticado; não armazena mensagens ou IDs de cliente em localStorage.

## Verificação

O CI [38168100442](https://github.com/HernanyManuel/Melissa/actions/runs/38168100442) passou migrações PostgreSQL, RLS, testes de integração e worker, formatação/lint/typecheck/backend, Flutter analyze/test/build web e Docker Compose. A integração testa validação, sequências inexistentes, replays duplicados, monotonicidade, isolamento entre tenants e entre dois operadores do mesmo tenant. O widget testa retenção depois de reload e **ausência de avanço após falha REST**, além de manter as regressões SSE de replay, reconexão e troca de tenant.

## Limites

- Este checkpoint representa **o último lote aplicado no contexto da página e filtro carregados**, não prova que o utilizador leu mensagens, nem que todos os históricos de todas as conversas foram sincronizados integralmente. A abertura posterior de outra conversa continua a consultar o histórico REST autorizado.
- O checkpoint é partilhado entre separadores/dispositivos do mesmo operador e tenant. Um deles pode avançar o ponto persistido sem que os restantes tenham renderizado todos os eventos; após reload, a listagem REST inicial volta a consultar o estado atual. O backend não promete sincronização de visualização em cada dispositivo.
- Sem execução automática fora da aplicação aberta, push/sons, armazenamento offline de mensagens, protocolo de delta de paginação completo, nem validação de envio real pela Meta. Eventos não aplicados com falhas persistentes continuam sujeitos a retries e a replay de segurança.
