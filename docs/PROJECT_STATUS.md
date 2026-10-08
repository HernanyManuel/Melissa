# Estado do projeto

## Atualização Phase 8 — Inbox Flutter com SSE/replay e refresh REST

A UI de conversas subscreve agora `GET /api/v1/tenants/:tenantId/inbox/events` através de um stream SSE autenticado, validando eventos mínimos e sequência monotónica por tenant. Na reconexão envia o último cursor via `Last-Event-ID`/`after`, ignora replay duplicado e aplica backoff. Mudança de tenant ou revogação de acesso cancela a subscrição e descarta o estado sensível.

Cada evento força uma nova leitura REST autorizada: a lista e o histórico da conversa selecionada atualizam sem trocar a seleção. Eventos são agrupados, refreshes REST serializados por tenant e a lista de IDs afetados é preservada para retry após falhas temporárias. Um teste específico prova que a chegada de dois eventos durante uma consulta REST lenta não perde a segunda atualização. Ver [ADR-080](decisions/ADR-080-flutter-inbox-sse-replay.md).

O workflow [37849570752](https://github.com/HernanyManuel/Melissa/actions/runs/37849570752) passou integralmente no commit funcional `84fca5867ca0034db9a6fd7bbfb643b444052b3e`: Flutter analyze/test/build web, backend e Docker Compose. O workflow [37846050931](https://github.com/HernanyManuel/Melissa/actions/runs/37846050931) já tinha validado os testes de parser, cursor, autenticação, replay, reconexão, atualização e troca de tenant.

Continuam por implementar: persistência de cursor entre sessões, reconciliação/recuperação da chave de retry de resposta manual após reload, notificações, unread count, notas/tags, painel de cliente completo e E2E real. As leituras de histórico já paginado estão limitadas à profundidade carregada (máximo de 10 páginas nesta fatia), sem snapshot transacional global. Não houve validação com provider WhatsApp live, merge ou deploy; o gate externo P7 para credenciais reais Google Calendar continua aberto.

## Atualização Phase 8 — Primeira fatia de UI Flutter para controlo humano

A interface de conversas inclui agora `ConversationHumanControls`, com indicação do modo, seleção de colaborador ativo, takeover, reativação da IA e fecho. Para conversas `HUMAN_ACTIVE` atribuídas e em canal WhatsApp live, há composer ligado a `POST /api/v1/tenants/:tenantId/conversations/:id/messages`; respostas incertas podem ser repetidas explicitamente com o mesmo `requestId` e o mesmo texto, sem criar uma nova intenção. Um resultado `pending` representa fila durável, `accepted` apenas aceitação pelo provider, nunca entrega. Ver [ADR-079](decisions/ADR-079-incremental-flutter-inbox-controls.md).

O workflow [37844039975](https://github.com/HernanyManuel/Melissa/actions/runs/37844039975) ficou integralmente verde no commit `e1327e8c43b234db270241b8aee1c7495a91a9d3`: Flutter gen-l10n/analyze/test/build web, backend migrations/unitários/integração/recovery/OpenAPI/audit e Compose. Novos testes Flutter provam takeover, retry com chave/payload estáveis, fecho, bloqueio de composer em canal mock e descarte de resposta HTTP tardia após mudar de conversa. O falhanço Calendar observado no workflow documental anterior não se repetiu.

A UI continua parcial: falta consumo SSE/reconnect na UI, painel de cliente, notificações, notas/tags, unread count, E2E e recuperação do requestId após navegação/reload. A chave de retry permanece apenas em memória no widget; não se deve reenviar com chave nova após um resultado incerto sem consultar o histórico/estado. Não foi validado WhatsApp live com credenciais reais, nem feito merge/deploy; o gate P7/Google Calendar real continua aberto.

## Atualização Phase 8 — Resposta manual durável e fenced (schema 56)

A terceira fatia do PR #7 implementa o backend de resposta humana por `POST /api/v1/tenants/:tenantId/conversations/:id/messages`. A permissão `conversations:reply` é permitida a owner/admin/manager/staff, não a viewer. O envio exige `HUMAN_ACTIVE` e atribuição válida; staff só responde pela própria identidade. O `requestId` é idempotente por tenant/ator e o HTTP 200 confirma apenas persistência da intenção, nunca a entrega. Ver [ADR-078](decisions/ADR-078-durable-fenced-human-replies.md).

O schema 56 adiciona `human_outbound_intents`, `human_outbound_dispatch` e `human_outbound_dead_letters`, com RLS/grants mínimos. O dispatcher revalida modo, `mode_epoch`, atribuição e canal WhatsApp live antes de chamar o provider: reativar a IA torna obsoletas as intenções humanas anteriores. Após aceitação do provider, o backend guarda a mensagem outbound de staff e publica `message.sent` no Inbox. O worker está desligado por omissão (`HUMAN_OUTBOUND_WORKER_ENABLED=false`) e não usa fallback mock silencioso.

O workflow [37842750417](https://github.com/HernanyManuel/Melissa/actions/runs/37842750417) ficou integralmente verde no commit `925f56f17066c08157ffe1d9e625ff02c5cf0eb4`. Foram validados migration/readiness schema 56, formatter, lint, typecheck, unitários, integração PostgreSQL/RLS da resposta manual (incluindo idempotência e fencing), worker real/recovery Redis, OpenAPI, audit de dependências, Compose e Flutter. O bloqueio de grant Prisma para `created_at` e campos de inicialização do dispatch foi corrigido com privilégios de coluna restritos.

P8 continua incompleto: faltam UI Flutter do Inbox e composer humano, consumo SSE na UI, notificações, notas/tags e E2E. Não houve validação WhatsApp live com credenciais reais nem merge/deploy. O gate externo P7/Google Calendar continua aberto.

## Atualização Phase 8 — Controlo humano + eventos real-time duráveis (schema 55)

A fundação do Inbox no PR #7 inclui agora controlo humano e um feed SSE durável tenant-scoped. Schema 54 introduziu `assigned_staff_id`, `closed_at`, a permissão `conversations:takeover` e os comandos autenticados de takeover, reativação da IA e fecho. Takeover preserva o grafo `AI_ACTIVE -> WAITING_HUMAN -> HUMAN_ACTIVE`; cada mudança real de modo avança `mode_epoch`, e o dispatcher volta a verificar modo/epoch antes de qualquer envio automático. Ver [ADR-076](decisions/ADR-076-human-conversation-control.md).

Schema 55 introduz `inbox_events`: log mínimo e durável com sequência monotónica por tenant. O endpoint autenticado `GET /api/v1/tenants/:tenantId/inbox/events` usa SSE, aceita cursor inicial `after` e recupera eventos perdidos através do header padrão `Last-Event-ID`. O payload real-time contém apenas tipo, conversation/message IDs e timestamp; conteúdo continua atrás dos endpoints REST existentes. Mensagens inbound, handoff da IA, takeover, reativação e fecho escrevem o evento na mesma transação da mutação original. Ver [ADR-077](decisions/ADR-077-durable-inbox-event-stream.md).

A integração com PostgreSQL/RLS e worker real prova replay após reconexão, isolamento cross-tenant, validação de cursor, evento de mensagem inbound e ausência de duplicação em replay de handoff. O workflow `37700844071` ficou integralmente verde no commit `fe7e327365f680006e699db9b179b7bc90ef660d`: migrations/schema 55, formatter, lint, typecheck, unitários, integração completa, restart/Redis recovery, OpenAPI, audit de dependências de produção, Compose e Flutter.

P8 continua em progresso: a resposta manual de staff já foi implementada na fatia seguinte (schema 56, descrita acima), mas faltam notificações, notas/tags e UI Inbox completa. O gate externo de P7 para Google Calendar com credenciais reais continua aberto.

## Atualização Phase 5/P7 — Rotação da chave persistente de credenciais Calendar (schema 53)

A chave de encriptação persistente das credenciais Google Calendar tem agora keyring versionado: uma chave atual de escrita e chaves anteriores temporárias de leitura. Credenciais sob uma chave antiga são re-encriptadas para a chave atual durante a leitura; um sweep operacional cobre credenciais inativas através de descoberta mínima `SECURITY DEFINER`, voltando ao scope RLS do tenant para a leitura/re-encriptação real. O comando `calendar:rotate-credential-key` falha fechado quando uma chave antiga está indisponível ou a migração não converge, e o runbook preserva as chaves antigas até o sweep concluir e documenta rollback. Ver [rotação da chave Calendar](calendar-credential-key-rotation.md).

Testes unitários cobrem sweep, bloqueio e não convergência; integração PostgreSQL prova re-encriptação old→current e leitura posterior com keyring apenas da chave atual. O workflow `37397283308` ficou integralmente verde no commit `3205b0d311b5ccb3387dbfda6d0e34667793c874`: backend, Docker Compose e Flutter, incluindo formatter, lint, typecheck, unitários, worker real/recovery, OpenAPI e audit de dependências de produção. Isto não equivale a rotação executada em staging/produção nem a validação live com uma conta Google real; runtimes live continuam desativados por omissão.

## Atualização Phase 5 — Outbox automática (schema 23)

Resposta live, conclusão do turno, usage e envelope de dispatch são persistidos atomicamente após fence final sob lock. Takeover concorrente produz `stale` sem outbound; conteúdo fica numa tabela tenant-scoped imutável e o índice global não o expõe. Ver [ADR-062](decisions/ADR-062-ai-automatic-outbox.md). Ainda sem consumer, adapter live, retries/recibos ou deploy.

## Atualização Phase 5 — Coordenador de turno

`ConversationTurnCoordinator` liga contexto, tools, engine, fencing e ledger com replay seguro e códigos de falha sanitizados. Uso consumido antes de fencing obsoleto é preservado; texto só é devolvido após finalização durável e erro de DB propaga para retry. Ver [ADR-061](decisions/ADR-061-conversation-turn-coordinator.md). Ainda sem queue/worker, outbox automática, handoff persistido ou deploy.

## Atualização Phase 5 — Ledger de turnos e usage (schema 22)

`ai_turns` fixa tenant/conversation/customer e versões de fencing; `ai_usage_events` regista uma única medição append-only por turno. Início idempotente, replay com scope exato, transição terminal e usage são protegidos transacionalmente; prompts/respostas não são persistidos. Ver [ADR-060](decisions/ADR-060-exactly-once-ai-turn-ledger.md). Ainda sem wiring ao worker, pricing/custo, reconciliação, outbound ou deploy.

## Atualização Phase 5 — AIProvider e AIGateway

Contrato vendor-neutral sem DB/rede, gateway com limites de contexto/output, tools allowlisted, JSON defensivo e erros sanitizados. Tenant/correlation não chegam ao provider; MockAIProvider determinístico permite testes. Ver [ADR-053](decisions/ADR-053-ai-provider-gateway-boundary.md) e [motor de IA](ai-engine.md). Sem adapter real, tool executor, persistência, integração com conversas, merge ou deploy.

## Atualização Phase 4 — Gate de malware ClamAV

MalwareScanner/ClamAV INSTREAM analisa bytes validados antes do storage. Apenas `OK` permite escrita; `FOUND`, timeout, erro ou resposta desconhecida falham fechados. Worker exige scanner completo, com limites de corpo/resposta/tempo; testes cobrem protocolo, deteção, indisponibilidade, configuração e ausência de escrita. Ver [ADR-052](decisions/ADR-052-clamav-malware-gate.md). Base real/updates/health/network policy ainda não validados; sem merge/deploy.

## Atualização Phase 4 — Assinaturas binárias de media

MediaIngestor confirma magic bytes de JPEG, PNG, PDF, OGG, MP3 e MP4 antes do storage, além da correspondência MIME/checksum/tamanho existente. Payload spoofed ou demasiado curto falha sem escrita; testes cobrem todas as assinaturas permitidas e divergência. Ver [ADR-051](decisions/ADR-051-media-binary-signatures.md). Parsing completo, polyglots e malware scanning continuam pendentes; sem merge/deploy.

## Atualização Phase 4 — Worker opt-in de ingestão media

Dispatcher PostgreSQL/BullMQ publica apenas UUID interno e tentativa; processador revalida tenant/payload. Arranque exige flag explícita, transporte Meta, S3 e keyring completos, sem fallback mock. Concorrência 2, lote 25, retries duráveis e shutdown ordenado; teste integrado usa Redis/PostgreSQL reais sem rede externa. Ver [ADR-050](decisions/ADR-050-opt-in-media-ingestion-worker.md). Nenhuma chamada Meta/S3 real, merge ou deploy.

## Atualização Phase 4 — Storage persistente S3-compatible

Adapter privado com SigV4, HTTPS estrito, credenciais temporárias opcionais, escrita condicional sem overwrite e GET limitado com verificação de tamanho/checksum. Factory fail-closed e configuração server-side explícita; sem fallback mock ou URL pública. Ver [ADR-049](decisions/ADR-049-s3-storage-provider.md). Ainda sem validação cloud real, bucket policy, lifecycle, ativação do worker, merge ou deploy.

## Atualização Phase 4 — Rotação de chaves de quarentena

Keyring fail-closed mantém uma chave atual de escrita e até quatro anteriores apenas para leitura. Valida base64 canónico de 32 bytes, IDs/material únicos, configuração completa e cópias defensivas; o webhook nunca cifra com chave anterior. Ver [ADR-048](decisions/ADR-048-quarantine-key-rotation.md). Sem secret manager, rotação automática, ativação do consumidor, merge ou deploy.

## Atualização Phase 4 — Ciclo transacional de ingestão media (schema 20)

Processador resolve tenant sem confiar na fila, autentica AES-256-GCM/AAD, valida a referência e usa o MediaIngestor idempotente. Tentativas, backoff e resultado mínimo ficam duráveis; conclusão e auditoria são serializadas e falhas não expõem detalhes do provider. Ver [ADR-047](decisions/ADR-047-media-ingestion-lifecycle.md). O worker continua desligado enquanto não existir StorageProvider persistente e rotação de chaves; sem downloads reais, merge ou deploy.

## Atualização Phase 4 — Envelope durável de media (schema 19)

Novos eventos media em quarentena criam envelope mínimo na mesma transação, sem ID externo/MIME/URL/telefone/payload; duplicação não repete e purga da quarentena remove por cascade. RLS, grants imutáveis, readiness e testes. Sem backfill ou consumidor. Ver [ADR-046](decisions/ADR-046-durable-media-ingestion-envelope.md). Nenhum download/storage real; sem merge/deploy.

## Atualização Phase 4 — Configuração media WhatsApp

Flag opt-in e campos separados para token, versão e hosts exatos; configuração incompleta/unsafe falha no arranque. Factory retorna null desligada e nunca cai para mock. `.env.example`, testes e docs atualizados. Ver [ADR-045](decisions/ADR-045-whatsapp-media-configuration.md). Adapter ainda não registado nem ligado a webhook/worker/DB; sem credenciais ou chamadas reais. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Adaptador HTTP de media WhatsApp

WhatsAppGraphMediaSource desligado por defeito: metadata em origem Graph fixa, Bearer server-side, versão explícita, allowlist exata de hosts, HTTPS/redirect/porta, timeout e streaming limitado. Erros sanitizados e testes fetch injetado. Ver [ADR-044](decisions/ADR-044-whatsapp-media-http-adapter.md). Sem defaults de hosts, credenciais, wiring, chamadas reais ou validação com conta Meta; ativação bloqueada. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Núcleo de ingestão de media

MediaSourceProvider e MediaIngestor com IDs opacos, allowlist MIME, correspondência do tipo declarado, limite de 10 MiB, SHA-256 opcional e chave tenant opaca. Mock sem rede e testes de replay/validação/falhas. Ver [ADR-043](decisions/ADR-043-safe-media-ingestion-core.md). Não ligado ao webhook/DB; sem download Meta, magic bytes, malware scan, reconciliação ou limpeza. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — StorageProvider para media

Contrato binário vendor-neutral e MockStorageProvider privado, limitado, idempotente e com cópias defensivas. Testes de concorrência, conflito, capacidade, chaves/tipos e delete. Ver [ADR-042](decisions/ADR-042-storage-provider-foundation.md). Ainda não descarrega media Meta, não liga DB/quarentena e não configura storage de produção; estes controlos são pré-requisitos do próximo incremento. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Polling outbound limitado

Após `pending`, Flutter consulta por GET uma vez/segundo até estado terminal ou 15 tentativas; nunca repete POST. Cancela em troca de contexto/fecho/nova intenção e mantém consulta manual. 429 respeita Retry-After. Ver [ADR-041](decisions/ADR-041-bounded-outbound-polling.md). Sem WebSocket, recovery após reload, requeue operacional ou envio real. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Estado outbound na API/UI

POST/GET expõem estado mínimo `pending`, `mock_accepted`, `rejected` ou `failed`; intenções históricas sem fila ficam `stored`. Sem payload, destinatário, tentativas ou erro. Flutter distingue estados em seis idiomas e consulta sem reenvio. Ver [ADR-040](decisions/ADR-040-outbound-processing-status.md). Retry operacional, polling e envio real pendentes. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Fila outbound mock

Schema 18 e envelope atómico para novas intenções; worker BullMQ com descoberta PostgreSQL, replay seguro e cinco falhas registadas antes de estado terminal. Testes de worker separado, recuperação do resultado persistido, retries e isolamento. Ver [ADR-039](decisions/ADR-039-outbound-mock-queue.md). Intenções antigas não são ativadas; API/UI continuam a indicar apenas armazenamento. Resultado visual, operação de falhas, retenção e envio real pendentes. Validação nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Processamento interno outbound mock

Schema 17: resultado imutável por intenção, RLS e auditoria transacional. Processador interno revalida permissões/canal/cliente/conversa e retorna o mesmo resultado em replay. Testes de concorrência, revogação, rollback e isolamento. Ver [ADR-037](decisions/ADR-037-outbound-mock-processing.md). Ainda sem dispatcher, ligação às filas ou resultado na API/UI; nenhum envio real. Validação integral nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Interface outbound de sandbox

Página a partir de conversas mock, com verificação de acesso/canal, armazenamento e consulta de recibo. Texto/UUID preservados em memória para retry; espera Retry-After e bloqueio após erros definitivos. Seis idiomas e testes widget de replay/consulta/limite/troca de tenant. Ver [ADR-036](decisions/ADR-036-outbound-sandbox-ui.md). Não envia mensagens nem altera histórico; recuperação após reload e dispatch pendentes. CI nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Rate limit outbound

Contadores Redis atómicos por utilizador: 30 gravações e 120 consultas por janela de 60s. 429 com Retry-After; falha do limiter devolve 503 antes de guardar intenção. Testes de concorrência, TTL, bloqueio, consulta independente e replay; OpenAPI atualizado. Ver [ADR-035](decisions/ADR-035-outbound-rate-limit.md). Sem envio real/UI; CI nos checks do PR #5, schema 16 mantido, sem merge/deploy.

## Atualização — Tooling de auditoria

pnpm 11.25.0 alinhado em projeto/CI/Docker para usar Bulk Advisory, com allowBuilds explícito e verificação da versão efetiva. Node 22 e dependências da aplicação preservados. Auditoria continua obrigatória, sem ignorar erros externos. Ver [ADR-034](decisions/ADR-034-pnpm-bulk-audit.md); resultado integral nos checks do PR #5. Sem merge/deploy.

## Atualização Phase 4 — API de intenções outbound

POST de sandbox para guardar intenção e GET de recibo mínimo, restritos a owner/admin. HTTP 200 significa `stored`, não queued/sent. OpenAPI explícito e testes HTTP de autenticação, RBAC, isolamento, concorrência, conflito e respostas sem conteúdo. Ver [ADR-033](decisions/ADR-033-outbound-sandbox-api.md). Sem UI, consumidor ou envio; schema 16. Rate limiting específico e retenção continuam pendentes. CI nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Aceitação interna outbound

Serviço de sandbox owner/admin com validação de conversa/cliente/canal mock, intenção e auditoria atómicas, replay idempotente e conflitos auditados. Limite temporário de 1000 intenções/tenant; resposta `stored` sem alegar envio. Testes PostgreSQL de concorrência, RBAC, quota e rollback. Ver [ADR-032](decisions/ADR-032-outbound-intent-acceptance.md). Sem API, UI, fila ou chamada ao provider; schema 16 mantido. CI nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Intenções outbound duráveis (schema 16)

Tabela imutável `outbound_intents`, RLS forçada, FKs compostas e chave idempotente por tenant/ator. Só provider mock; sem API/consumidor ou envio. Testes de persistência, rollback, isolamento, grants e concorrência. Ver [ADR-031](decisions/ADR-031-durable-outbound-intents.md). Autorização de envio, auditoria/replay, dispatch/worker, retenção e UI continuam pendentes. Readiness exige schema 16; validação integral nos checks do PR #5. Sem merge/deploy.

## Atualização Phase 4 — MessagingProvider outbound

Contrato de envio de texto, registo fail-closed e MockMessagingProvider idempotente em processo. Testes de concorrência/conflito e bloqueio de live/desligado/tipo desconhecido. Ver [ADR-030](decisions/ADR-030-messaging-provider-abstraction.md). Fundação ainda não ligada a API/outbox/worker; nenhuma mensagem é enviada. Durabilidade, adapter Meta e UI continuam pendentes. CI nos checks do PR #5; sem migration, merge ou deploy.

## Atualização Phase 4 — Pesquisa de conversas

API/Flutter pesquisam por nome do cliente ou canal, sem pesquisar conteúdo. Query limitada/escapada, paginação preservada, seis idiomas, limpar e proteção contra respostas atrasadas. Testes HTTP/UI e isolamento adicionados. Ver [ADR-029](decisions/ADR-029-conversation-name-search.md). Carga/índices para pesquisa em grande escala continuam pendentes. CI nos checks do PR #5; sem migration, merge ou deploy.

## Atualização Phase 4 — Índice de processamento (schema 15)

Índice por tenant/estado/id para a vista operacional, preservando o índice de dispatch global. Migration com timeouts limitados, readiness atualizado e teste de catálogo/estrutura. Ver [ADR-028](decisions/ADR-028-processing-tenant-index.md). Não constitui benchmark; carga representativa e rollout live concorrente continuam pendentes. CI nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Vista de processamento

API e Flutter owner/admin para mensagens pending/failed/rejected, com paginação e metadados mínimos. Sem conteúdo, reenvio ou cancelamento. Seis idiomas, OpenAPI e testes HTTP/RBAC/isolamento/UI. Ver [ADR-027](decisions/ADR-027-processing-operations.md). Escala/índice adicional e painel admin global continuam pendentes. CI nos checks do PR #5; sem migration, merge ou deploy.

## Atualização Phase 4 — Integridade dos recibos

Corrigida inferência indevida de processed quando faltava dispatch. Apenas eventos inbound mock/whatsapp possuem recibo; quarentena/callbacks devolvem 404 e evidência incompleta devolve 503 sanitizado. Testes de invariantes, HTTP/isolamento e recuperação de consulta Flutter adicionados. Ver [ADR-026](decisions/ADR-026-receipt-integrity.md). Sem mudança de schema, merge ou deploy; validação nos checks do PR #5.

## Atualização Phase 4 — Simulação inbound no Flutter

Canal mock ativo permite selecionar cliente, enviar texto pela outbox/fila e consultar recibo. Repetição em caso de rede reutiliza UUID/payload em memória; 202 não é apresentado como processamento concluído. Seis idiomas, clientes paginados, testes de replay/consulta/modo live/isolamento visual. Ver [ADR-025](decisions/ADR-025-inbound-simulation-ui.md). Não envia WhatsApp, não executa IA nem garante idempotência após reload. CI nos checks do PR #5; sem merge/deploy.

## Atualização Phase 4 — Página de canais

Flutter permite listar/criar canais mock e desligá-los com confirmação, através das APIs existentes. Acesso owner/admin, seis idiomas, estados de UI e proteção contra respostas tardias/duplicação por repetição automática. Canais live apenas de consulta. Ver [ADR-024](decisions/ADR-024-channel-management-ui.md). Testes novos de interface; CI nos checks do PR #5. Simulação de mensagens pela UI e provisioning Meta permanecem pendentes. Sem merge/deploy.

## Atualização Phase 5 — ConversationEngine limitado

Adicionado loop neutral de até quatro rondas/oito tools, resultados tipados, execução sequencial, usage acumulado e `handoff_required` ao atingir limites. `ConversationFence` revalida associação tenant/conversation/customer, `AI_ACTIVE` e `mode_epoch` antes/depois do provider, antes de cada tool e antes do resultado final. O adapter OpenAI suporta pares `function_call`/`function_call_output`. Ver [ADR-059](decisions/ADR-059-bounded-conversation-engine-loop.md). Ainda sem worker, persistência do turno, cost guard, auditoria, outbound ou mudança real para handoff. Validação local/CI pendentes; sem merge/deploy.

## Atualização Phase 5 — Estado versionado e fencing

Schema 21 adiciona `mode_epoch`, `state_version`, estado V1 e trigger DB que impede alterações não versionadas. `ConversationStateService` valida shape/transições e faz compare-and-swap por tenant/conversation/customer, `AI_ACTIVE`, epoch e versão; workers antigos falham sem commit. Contadores BigInt internos são removidos da API pública. Ver [ADR-058](decisions/ADR-058-conversation-state-fencing.md). Ainda sem endpoints de takeover, auditoria, loop IA ou outbound automático. Validação local/CI pendentes; sem merge/deploy.

## Atualização Phase 5 — AIContextBuilder mínimo

Adicionados `AIContextBuilder` e `PrismaAIContextSource`: associação tenant/conversation/customer validada sob RLS, política de sistema estática, referência JSON marcada como não confiável, campos públicos mínimos, até 12 mensagens e orçamentos determinísticos. Contactos/notas/consentimentos/credenciais/metadata são excluídos; live exige conversa `AI_ACTIVE`. Ver [ADR-057](decisions/ADR-057-minimal-untrusted-ai-context.md). Ainda não há state version, resumo, metering, loop de tools ou ligação ao worker; sem ativação real. Validação local e CI pendentes; sem merge/deploy.

## Atualização Phase 5 — Tools read-only de negócio

Implementadas seis tools server-owned (`get_business_info`, `get_services`, `get_service_details`, `get_price`, `get_business_hours`, `get_staff`) com schemas fechados, validators semânticos, capabilities e porta `BusinessToolReader`. O adapter Prisma usa transação curta, `app.tenant_id`, filtros tenant explícitos, campos públicos mínimos e strings decimais. Testes impedem injeção de tenant, UUID/data inválidos e acesso sem capability. Ver [ADR-056](decisions/ADR-056-tenant-scoped-business-read-tools.md). Ainda não ligadas ao worker/loop; sem tráfego, escrita ou ativação real. Validação local e CI pendentes; sem merge/deploy.

## Atualização Phase 5 — Registry e executor seguro de tools

Adicionados `ToolRegistry` e `ToolExecutor` controlados pelo backend: schemas e handlers server-side, capabilities obrigatórias, contexto tenant/customer/conversation injetado, idempotency key derivada do turno, validação semântica, outputs JSON limitados, até oito calls sequenciais, timeout e erros sanitizados. Registos de escrita/handoff sem suporte declarado a idempotência são recusados. Ver [ADR-055](decisions/ADR-055-server-owned-tool-registry.md). Ainda não existem handlers reais, loop conversacional, persistência, auditoria ou metering; a IA continua sem acesso a dados/efeitos reais. Validação local e CI pendentes; sem merge/deploy.

## Atualização Phase 5 — Adapter OpenAI Responses

Adicionado adapter real, mas opt-in, atrás de `AIProvider`/`AIGateway`: endpoint fixo, chave e modelo explícitos server-side, timeout, resposta limitada, `store: false`, schemas de tools estritos e parsing fechado de texto/tool calls. Seleção `disabled|mock|openai` sem fallback silencioso e testes de contrato sem rede. Ver [ADR-054](decisions/ADR-054-openai-responses-adapter.md). Não foram usadas credenciais nem feitas chamadas reais; executor de tools, estado, metering, integração com conversas e UI continuam pendentes. Validação local e CI do commit desta alteração ainda pendentes; sem merge/deploy.

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
