# Estado do projeto

## Atualização Phase 4 — Vista de processamento

API e Flutter owner/admin para mensagens pending/failed/rejected, com paginação e metadados mínimos. Sem conteúdo, reenvio ou cancelamento. Seis idiomas, OpenAPI e testes HTTP/RBAC/isolamento/UI. Ver [ADR-027](decisions/ADR-027-processing-operations.md). Escala/índice adicional e painel admin global continuam pendentes. CI nos checks do PR #5; sem migration, merge ou deploy.

## Atualização Phase 4 — Integridade dos recibos

Corrigida inferência indevida de processed quando faltava dispatch. Apenas eventos inbound mock/whatsapp possuem recibo; quarentena/callbacks devolvem 404 e evidência incompleta devolve 503 sanitizado. Testes de invariantes, HTTP/isolamento e recuperação de consulta Flutter adicionados. Ver [ADR-026](decisions/ADR-026-receipt-integrity.md). Sem mudança de schema, merge ou deploy; validação nos checks do PR #5.

## Atualização Phase 4 — Simulação inbound no Flutter

Canal mock ativo permite selecionar cliente, enviar texto pela outbox/fila e consultar recibo. Repetição em caso de rede reutiliza UUID/payload em memória; 202 não é apresentado como processamento concluído. Seis idiomas, clientes paginados, testes de replay/consulta/modo live/isolamento visual. Ver [ADR-025](decisions/ADR-025-inbound-simulation-ui.md). Não envia WhatsApp, não executa IA nem garante idempotência após reload. CI nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Página de canais

Flutter permite listar/criar canais mock e desligá-los com confirmação, através das APIs existentes. Acesso owner/admin, seis idiomas, estados de UI e proteção contra respostas tardias/duplicação por repetição automática. Canais live apenas de consulta. Ver [ADR-024](decisions/ADR-024-channel-management-ui.md). Testes novos de interface; CI nos checks do PR #5. Simulação de mensagens pela UI e provisioning Meta permanecem pendentes. Sem merge/deploy.

## Atualização Phase 4 — Contrato OpenAPI de quarentena

DTOs explícitos, operationId estável, cursor, campos obrigatórios, datas, avisos, erros e cabeçalhos documentados. Testes verificam o esquema gerado e os cabeçalhos/validação HTTP. Ver [ADR-023](decisions/ADR-023-quarantine-openapi-contract.md). Sem alteração do formato HTTP ou UI; geração de cliente Dart e contratos restantes não concluídos. Validação integral nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Recuperação do transporte Redis

Teste do worker inclui corte real dos seus sockets Redis via proxy loopback, readiness 503/liveness 200, backlog preservado no PostgreSQL e retoma no mesmo processo após reconexão. Replay/auditoria/payload verificados. Ver [ADR-022](decisions/ADR-022-redis-transport-recovery.md). A API mantém a sua ligação; falha global/restart do servidor Redis e interrupção durante processamento continuam pendentes. CI nos checks do PR #5; sem alteração funcional, merge ou deploy.

## Atualização Phase 4 — Reinício abrupto do worker

Adicionado cenário CI com worker filho real terminado por SIGKILL, aceitação HTTP durante paragem, recuperação da outbox após reinício e replay sem duplicar mensagem/auditoria. Ver [ADR-021](decisions/ADR-021-worker-restart-verification.md). Não cobre morte em processamento, indisponibilidade Redis ou failover DB. Lint local aprovado; execução integral nos checks do PR #5. Sem alteração funcional, merge ou deploy.

## Atualização Phase 4 — Avisos operacionais

Página de quarentena sinaliza ocupação ≥80%, capacidade esgotada, expiração próxima e limpeza pendente. Regras determinísticas no backend e capacidade partilhada com ingresso; traduções e testes adicionados. Ver [ADR-020](decisions/ADR-020-quarantine-operational-notices.md). São avisos da última consulta, não alertas enviados ou monitorização contínua. Notificações automáticas, revisão do conteúdo e reprocessamento continuam pendentes. CI nos checks do PR #5; sem ativação, merge ou deploy.

## Atualização Phase 4 — Consulta da quarentena

API e página Flutter de metadados, restritas a owner/admin, com paginação, contadores e prazos. Sem acesso ao conteúdo cifrado. Inclui seis idiomas, estados de UI e testes de isolamento/RBAC/respostas tardias. Ver [ADR-019](decisions/ADR-019-quarantine-metadata-operations.md). Validação integral nos checks do PR #5. Revisão do conteúdo, reprocessamento e alertas continuam pendentes. Phase 4 não concluída; sem ativação real, merge ou deploy.

## Atualização Phase 4 — Purga automática (schema 14)

Worker elimina payloads cifrados de quarentena expirados, em lotes de até 100, com auditoria transacional e descoberta independente de bindings WhatsApp. Mantém ledger/dedupe e não restaura conteúdo em replay. Ver [ADR-018](decisions/ADR-018-quarantine-retention-worker.md). Testes incluem scheduler separado e concorrência; CI nos checks do PR #5. Revisão/reprocessamento, alertas e política de backups continuam pendentes. Sem ativação real, merge ou deploy.

## Atualização Phase 4 — Quarentena cifrada (schema 13)

Eventos não suportados com âmbito de canal verificado podem ser capturados em quarentena AES-256-GCM, com chave independente opt-in, dedupe e auditoria. Sem executar IA/descarregar media/criar clientes. Ver [ADR-017](decisions/ADR-017-encrypted-whatsapp-quarantine.md). Expiração registada e DELETE restrito a expirados; purga automática/revisão ainda pendentes. Lint/testes locais do adapter aprovados; CI integral nos checks do PR #5. Sem ativação real, merge ou deploy.

## Atualização Phase 4 — Endpoint WhatsApp opt-in

GET/POST /webhooks/whatsapp implementados com default 404, raw-body, limite de tamanho e rate limit Redis. ACK apenas após commit durável. Configuração explícita server-side obrigatória; produção mantém bloqueio. Testes HTTP adicionados, lint local aprovado; CI nos checks do PR #5. Ver [ADR-016](decisions/ADR-016-whatsapp-http-gate.md). Endpoint não exposto/ativado; provisioning real e tratamento durável de media continuam pendentes. Sem merge/deploy.

## Atualização Phase 4 — Histórico de estados WhatsApp (schema 12)

Callbacks sent/delivered/read/failed são persistidos com idempotência, auditoria e RLS; histórico append-only preserva eventos fora de ordem. Não altera mensagens recebidas nem cria clientes. Ver [ADR-015](decisions/ADR-015-whatsapp-status-journal.md). Lint local aprovado; CI integral nos checks do PR #5. Correlação/estado visual de envios, endpoint público, media e outbound continuam pendentes. Sem merge/deploy.

## Atualização Phase 4 — Novos clientes inbound (schema 11)

Texto WhatsApp verificado pode cadastrar cliente na mesma transação da outbox. Índice tenant/telefone e lock impedem duplicação; arquivo não é revertido. Consentimentos explícitos com default unknown, sem inferência ou alteração de preferências existentes. Ver [ADR-014](decisions/ADR-014-inbound-customer-resolution.md). Lint local aprovado; validação integral nos checks do PR #5. Ingresso ainda interno, sem endpoint público, callbacks/media ou envios. Sem merge/deploy.

## Atualização Phase 4 — Outbox de origem externa (schema 10)

WhatsAppIngress liga assinatura, normalização, routing e outbox para texto de clientes existentes. Worker distingue autorização externa de membership mock e volta a validar o binding. Auditoria de origem externa sem utilizador fictício; batching partilhado. Ver [ADR-013](decisions/ADR-013-external-inbound-outbox.md). Testes de integração adicionados; CI nos checks do PR #5. Não existe endpoint público/provisioning real; novos clientes, callbacks e media permanecem pendentes. Sem merge/deploy.

## Atualização Phase 4 — Resolução de canal WhatsApp (schema 9)

Registo de encaminhamento interno com escrita reservada a provisioning confiável e resolver transacional por integração/WABA/número. Revalida canal live ativo, associa tenant via DB e mantém RLS sobre os dados. Ver [ADR-012](decisions/ADR-012-whatsapp-routing.md). Não ligado ao HTTP/outbox; origem externa sem utilizador, provisioning e auditoria de sistema ainda pendentes. Validação desta alteração nos checks do PR #5. Sem merge/deploy.

## Atualização Phase 4 — Adaptador inbound WhatsApp

Adicionado contrato de transporte e adaptador com validação de assinatura raw-body, challenge, normalização de texto/status e identificação de eventos não suportados. Ver [contrato e limites](whatsapp-inbound.md). Não ligado ao HTTP, à outbox ou a canais reais: este incremento é uma biblioteca backend testável, não integração WhatsApp concluída. Lint local aprovado; CI integral nos checks do PR #5. Sem merge/deploy.

## Atualização Phase 4 — Lock e batching inbound (schema 8)

Implementados lease Redis renovável por tenant/canal/cliente e lotes duráveis com janela de silêncio configurável, limite de cinco segundos e 50 eventos. Mensagens permanecem individuais e associadas ao lote; ainda não há consumidor IA nem resposta agrupada. Ver [ADR-011](decisions/ADR-011-conversation-lock-batching.md). Lint local aprovado; execução integral desta alteração nos checks do PR #5. Sem merge/deploy.

Entregas acumuladas: clientes e UI, canais mock, histórico e UI de conversas, outbox/worker/retries, lock e debounce mock. Continuam pendentes WhatsApp real, outbound, callbacks/media, handoff, IA e validação de falhas reais/stress. As secções seguintes são histórico das entregas e não substituem este resumo atual.

## Atualização Phase 4 — Outbox inbound

Receção mock agora assíncrona: HTTP 202 com recibo após commit durável; dispatcher PostgreSQL→BullMQ; worker valida tenant/canal/cliente/membership, grava mensagem e conclui envelope na mesma transação. Retry limitado com backoff, estados rejected/failed e limpeza do payload da outbox após processamento. Schema version 7. Ver docs/decisions/ADR-010-inbound-outbox.md e docs/messaging-sandbox.md.

Regressões adicionadas: consumo por worker separado, duplicação pós-commit, recibo cross-tenant, backlog enquanto fila pausada, retoma, canal revogado e limite de tentativas. CI integral aprovada no commit `af852ba`: https://github.com/HernanyManuel/Melissa/actions/runs/33649816928. Queda real de Redis e restart forçado ainda não testados; não equiparar teste de pause/resume a esses cenários. WhatsApp live, outgoing queue e locks/debounce de conversa permanecem pendentes. Sem merge/deploy.

## Phase 4 — Rascunho parcial: clientes

Continuação UI de conversas: `/conversations/:tenantId`, lista e histórico apenas de leitura, paginação, layout adaptado a mobile/desktop, seis idiomas, estados vazio/erro/loading e proteção contra respostas atrasadas após trocar conversa/empresa. Ações de envio e handoff não implementadas. Novos testes widget de recuperação de erro, leitura mobile/paginação e resposta atrasada. CI desta alteração pendente; Flutter indisponível localmente. CI do backend de mensagens `91c2197` aprovada: https://github.com/HernanyManuel/Melissa/actions/runs/33640469877.

Continuação mensagens: persistência transacional de eventos/conversas/mensagens para canais mock, dedupe, conflito de payload auditado, APIs de histórico paginado e testes. Ver [contrato e limitações](messaging-sandbox.md). Sem queue ou WhatsApp real nesta entrega; CI do novo commit pendente. CI do cadastro de canais `7d112dc` aprovada integralmente: https://github.com/HernanyManuel/Melissa/actions/runs/33638991311.

Continuação canais: cadastro/revogação de simulações WhatsApp com migration/RLS, IDs externos gerados, respostas sem secrets, permissões owner/admin e auditoria idempotente. Testes adicionados; ver [contrato e limites](channels.md). Não envia mensagens e não liga WhatsApp real. Validação local interrompida por autorização de rede; CI do novo commit pendente.

Interface de clientes no commit `93a1b33`: CI integral aprovada em https://github.com/HernanyManuel/Melissa/actions/runs/33638043602. As referências anteriores a UI pendente descrevem o estado antes desta execução.

Continuação UI: página Flutter `/customers/:tenantId` ligada à API, acessível pela empresa selecionada. Inclui lista paginada, criação, edição, confirmação de arquivo, estados de carregamento/vazio/erro, tratamento de telefone duplicado e traduções nos seis idiomas. Os controlos de escrita respeitam o papel devolvido pelo servidor; a API continua a autoridade de permissões. Novos testes widget cobrem lista vazia, staff sem escrita e formulário com duplicado. Flutter não está instalado localmente; execução na CI pendente para esta alteração.

CI do commit `99a6533` aprovada integralmente: https://github.com/HernanyManuel/Melissa/actions/runs/33637124294 (inclui novas regressões backend de clientes). Este resultado não valida a UI adicionada posteriormente.

Branch `feature/phase-4-messaging`, baseada em `feature/phase-3-business-onboarding` no commit `1c5c2507bdfd350b0b4bf4a475a579786bbeda36`. Publicação em rascunho autorizada pelo utilizador; não pronta para merge ou produção.

Código inicial: modelo Customer, migration com RLS forçada, telefone único por tenant, listagem paginada, criação, atualização integral e arquivo lógico, permissões específicas e auditoria transacional. CORS passa a permitir PUT/DELETE para a origem configurada. A especificação original permanece intacta.

Validação inicial: backend e Compose do commit `f4a450b` passaram na execução GitHub Actions `33636792678`. A tentativa local anterior de gerar Prisma foi interrompida por autorização de rede cancelada; os checks remotos permitem executar migrations e a suite existente sem ambiente do utilizador.

A continuação adiciona regressões HTTP/PostgreSQL para clientes à suite de integração existente: autenticação, isolamento A/B, validação, duplicados concorrentes, telefone por tenant, RLS sem contexto, paginação, atualização integral, arquivo e auditoria. Acrescenta teste unitário da matriz de permissões. Execução destas novas regressões pendente da CI do novo commit; testes HTTP de cada papel e UI ainda pendentes. Não confundir testes escritos com testes aprovados.

Ainda não entregue nesta fase: restantes campos do modelo especificado (incluindo consentimentos e preferências), canais, WhatsApp, conversas, mensagens, outbox, filas, debounce e media. Testes UI completos de edição/arquivo/paginação e testes HTTP por papel ainda pendentes. Nenhum envio real, merge ou deploy efetuado. A Phase 4 permanece incompleta, mesmo que os checks existentes passem.

Contrato inicial: `/api/v1/tenants/:tenantId/customers` aceita GET (50 itens e cursor `after`) e POST; `/:id` aceita PUT e DELETE (arquivo lógico). Owner/admin/manager podem ler e escrever; staff apenas ler; viewer sem acesso. O telefone continua reservado após arquivo. PUT substitui os campos editáveis e limpa email/notas omitidos; não constitui PATCH parcial. Arquivo não é eliminação definitiva de dados pessoais.

## Phase 3 — Onboarding e configuração

Branch `feature/phase-2-identity`, PR #3, base empilhada sobre PR #2. Código de contas, verificação/reset, sessões revogáveis, tenants, memberships, convites, RBAC, auditoria e RLS implementado. Flutter Web ligado, com seis idiomas e consentimento de desenvolvimento.

CI do commit `357d681` aprovado: backend (migrations, lint, typecheck, quatro testes unitários e duas suites de integração com PostgreSQL/Redis), Flutter (análise, seis testes e build Web), Compose e auditoria sem vulnerabilidades conhecidas. [Execução verificada](https://github.com/HernanyManuel/Melissa/actions/runs/33579326319). A revisão final alinha nomes físicos da DB com snake_case; os checks do commit mais recente estão no PR #3. Sem merge nem deploy.

Phase 3 adiciona perfil, templates, serviços, horários/exceções, equipa, FAQs, políticas e personalidade com migration, RLS, APIs e wizard Flutter localizado. Branch `feature/phase-3-business-onboarding`, PR #4 sobre o PR #3. Validação final nos checks do PR; sem merge nem deploy.

Ver [entrega e limites da Phase 3](phase-3.md), [segurança de identidade](phase-2.md) e [plano](../IMPLEMENTATION_PLAN.md). P4 corresponde a clientes, canais, WhatsApp, conversas e mensagens.
