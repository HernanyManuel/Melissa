# Estado do projeto

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
