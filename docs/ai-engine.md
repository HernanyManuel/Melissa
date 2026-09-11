# Motor de conversação e IA

Pipeline partilhado por todos os tenants; configuração versionada, contexto mínimo e ferramentas explícitas. A IA interpreta linguagem e propõe intenções; o backend valida e executa ações determinísticas. O modelo nunca acede diretamente ao PostgreSQL, Redis, storage ou credenciais.

## Estado atual

`AIProvider` define o contrato vendor-neutral de completion. `AIGateway` valida contexto e respostas, limita tool calls e rejeita tools não autorizadas. `MockAIProvider` permite testes sem rede. O adapter opt-in `OpenAIResponsesProvider` traduz o contrato para a Responses API, com timeout, resposta limitada, `store: false`, tools estritas e erros fechados. O provider permanece desligado por omissão e nenhuma credencial real é incluída no repositório. Ver [ADR-053](decisions/ADR-053-ai-provider-gateway-boundary.md) e [ADR-054](decisions/ADR-054-openai-responses-adapter.md).

A Phase 5 já inclui registry/executor de tools, contexto tenant-scoped, state fencing, loop limitado do `ConversationEngine`, ledger exatamente-once, coordenação replay-safe, handoff durável inbound → AI, consumer de turnos, outbox automática, dispatcher com fence final, fila de dispatch e fronteira de transporte WhatsApp live. Os runtimes de inferência e outbound estão ligados ao `worker.ts` apenas por flags opt-in independentes e permanecem desligados por omissão; portanto a configuração normal não inicia inferência nem envio automático live. Ver [ADR-066](decisions/ADR-066-durable-inbound-ai-turn-trigger.md) e [ADR-067](decisions/ADR-067-opt-in-ai-turn-runtime.md).

### Configuração do provider e workers

- `AI_PROVIDER=disabled` é o default seguro.
- `AI_PROVIDER=mock` ativa somente o provider determinístico local.
- `AI_PROVIDER=openai` exige `OPENAI_API_KEY` e `OPENAI_MODEL` server-side.
- `OPENAI_TIMEOUT_MS` aceita 1000–60000 e usa 45000 por omissão.
- `AI_TURN_WORKER_ENABLED=false` mantém o consumer de turnos desligado; ativá-lo exige provider explícito.
- `AI_OUTBOUND_WORKER_ENABLED=false` mantém o transporte automático desligado e tem requisitos próprios de secrets/routing.

Não existe fallback automático para mock. A configuração rejeita `mock` quando turn worker e outbound live estão ambos ativos, para impedir que uma resposta sintética de testes seja enviada por WhatsApp. No perfil Compose, credenciais/configuração OpenAI são passadas apenas ao serviço `worker`, não ao serviço API. O endpoint OpenAI é fixo para impedir que configuração transforme este transporte num cliente HTTP arbitrário.

### Registry e execução de tools

`ToolRegistry` mantém o catálogo server-side com schema, efeito, capabilities, validator e handler. `ToolExecutor` revalida a resposta do provider, injeta tenant/customer/conversation e modo de execução confiáveis, gera idempotency key por turno/call e devolve somente resultados ou códigos de erro sanitizados. Escritas e handoff exigem suporte declarado a idempotência; execução é sequencial, limitada a oito calls e sujeita a timeout. Ver [ADR-055](decisions/ADR-055-server-owned-tool-registry.md).

O registry/executor ainda não contém todos os 14 handlers de domínio. O runtime de turnos regista somente as seis tools read-only já implementadas e concede somente as capabilities correspondentes; tools ausentes não podem ser autorizadas pelo modelo.

### Primeiras tools de leitura

Foram registados handlers para `get_business_info`, `get_services`, `get_service_details`, `get_price`, `get_business_hours` e `get_staff`. Todos usam schemas fechados e uma porta `BusinessToolReader`; o adapter Prisma abre uma transação curta com RLS, aplica o tenant do contexto e devolve apenas campos públicos mínimos. Preços são strings decimais, serviços inativos/arquivados e staff inativo são excluídos. Ver [ADR-056](decisions/ADR-056-tenant-scoped-business-read-tools.md).

Estas seis tools são ligadas ao `ConversationTurnCoordinator` apenas quando `AI_TURN_WORKER_ENABLED=true`. A configuração default continua sem inferência e sem acesso do provider aos dados de negócio.

### Construção de contexto

`AIContextBuilder` mantém a política de sistema estática e coloca perfil, preferências, políticas, FAQs, serviços e dados mínimos do cliente num bloco JSON marcado como não confiável. `PrismaAIContextSource` exige a associação tenant/conversation/customer sob RLS. Não inclui telefone, email, notas, consentimentos, credenciais ou metadata operacional. O contexto usa até 12 mensagens recentes, trunca campos e reduz listas até respeitar um orçamento de aproximadamente 24 mil caracteres. Ver [ADR-057](decisions/ADR-057-minimal-untrusted-ai-context.md).

O modo live exige `AI_ACTIVE`; sandbox pode preparar contexto pausado sem ativar a conversa. Delimitação de dados não substitui a autorização server-side das tools nem torna o sistema imune a prompt injection.

### Estado e fencing

O schema 21 adiciona `mode_epoch` e `state_version` monotónicos às conversas e normaliza o estado para V1. O trigger PostgreSQL incrementa o epoch quando o modo muda e exige incremento exato da versão quando o estado muda. `ConversationStateService` usa compare-and-swap por tenant/conversation/customer, modo ativo, epoch e versão; workers obsoletos falham fechados. Ver [ADR-058](decisions/ADR-058-conversation-state-fencing.md).

O mesmo princípio é aplicado até ao limite de outbound: o intent guarda o epoch e o dispatcher revalida modo/epoch imediatamente antes do efeito externo. Uma operação já aceite pelo provider não pode ser desfeita apenas pelo epoch; por isso o sistema não promete retirar mensagens que já estejam em trânsito.

### ConversationEngine

O núcleo executa até quatro rondas e oito tools totais. Cada resposta com tools é reintroduzida no protocolo neutral como pares `tool_call`/`tool_result`; o adapter OpenAI traduz esses pares para itens da Responses API. As tools são sequenciais e o `ConversationFence` revalida tenant/conversation/customer, `AI_ACTIVE` e `mode_epoch` antes/depois da inferência, antes de cada tool e antes do texto final. Limites resultam em `handoff_required`. Ver [ADR-059](decisions/ADR-059-bounded-conversation-engine-loop.md).

O engine continua sem efeitos de transporte próprios. O runtime opt-in apenas o compõe com contexto, tools, ledger e coordinator; persistência/replay são responsabilidade do ledger/coordenador e outbound é responsabilidade da outbox/dispatcher, evitando que o provider ou o loop escrevam diretamente efeitos externos.

### Ledger de turnos e usage

O schema 22 introduz `ai_turns` e `ai_usage_events` com RLS forçada, FKs compostas e finalização transacional exatamente-once. `AITurnLedger` fixa cada `turn_id` a tenant/conversation/customer/epoch/version, distingue replay em curso ou terminado e grava um único evento append-only com provider/model, tokens, resultado, rondas e número de tools. Não guarda prompts, respostas, mensagens nem argumentos/resultados de tools. Ver [ADR-060](decisions/ADR-060-exactly-once-ai-turn-ledger.md).

O ledger é usado pelo runtime de turnos somente quando o consumer opt-in está ativo. Catálogo de pricing versionado, custo monetário e reconciliação de turnos abandonados permanecem pendentes.

### Coordenação e dispatch do turno

`ConversationTurnCoordinator` compõe registry, context builder, engine e ledger numa única fronteira replay-safe. Só devolve texto depois de finalizar o ledger; entrega duplicada em curso ou terminada não repete provider. Falhas recebem códigos sanitizados. Quando o fencing fica obsoleto depois de uma chamada, os tokens já acumulados seguem para o outcome `stale`. Falha de persistência continua a propagar para retry, em vez de ser apresentada como resultado funcional. Ver [ADR-061](decisions/ADR-061-conversation-turn-coordinator.md).

O schema 24/25 adiciona `ai_turn_intents` tenant-scoped e o envelope global mínimo `ai_turn_dispatch`. A ingestão live cria o handoff durável apenas para conversas WhatsApp live em `AI_ACTIVE`; não executa o modelo dentro da transação inbound. A fila `ai-conversation-turns` publica apenas `{id, attempt}` e o `AITurnProcessor` volta a resolver tenant/conversation/customer/epoch/version no servidor antes de chamar o coordinator. Customer divergente, epoch/version obsoletos, conversa encerrada, customer removido ou canal não-live são rejeitados antes de inferência. Ver [ADR-066](decisions/ADR-066-durable-inbound-ai-turn-trigger.md).

Replay `already_running` apenas adia o envelope sem gastar uma tentativa. Replay terminado consulta o outcome persistido em `ai_turns`: `completed`/`handoff_required` fecham o dispatch como processado, `stale` como rejeitado e `failed` como falhado. Inconsistência de ledger entra no retry durável em vez de ser tratada como sucesso. O runtime completo é iniciado pelo worker apenas sob `AI_TURN_WORKER_ENABLED=true`. Ver [ADR-067](decisions/ADR-067-opt-in-ai-turn-runtime.md).

### Outbox automática

O schema 23 separa `ai_outbound_intents` da outbox humana e mantém conteúdo apenas na tabela tenant-scoped; `ai_outbound_dispatch` expõe globalmente ao dispatcher só ID, tenant, estado e retry. Para respostas live, finalização do turno, usage, intent e envelope são uma única transação. O commit bloqueia a conversation e revalida modo/epoch; takeover concorrente converte o turno em `stale`, conserva usage e suprime o texto. Ver [ADR-062](decisions/ADR-062-ai-automatic-outbox.md).

`startAIAutomaticOutboundQueue` implementa descoberta PostgreSQL → BullMQ e publica apenas `{id, attempt}`. O job rejeita tenant, conteúdo, destinatário ou campos extra; o dispatcher volta a resolver a verdade no servidor. `worker.ts` inicia esta composição somente quando `AI_OUTBOUND_WORKER_ENABLED=true`; o default continua desligado.

### Dispatcher automático e transporte WhatsApp live

`AIAutomaticOutboundDispatcher` usa lease por intent, resolve o tenant pelo envelope persistido e revalida `AI_ACTIVE`, `mode_epoch`, conversation/customer/channel e routing imediatamente antes do efeito externo. `external_phone_id` e `credentials_reference` vêm da `ChannelConnection`; para WhatsApp live são obrigatórios e são novamente comparados no segundo fence. Não existe fallback live → mock. Ver [ADR-063](decisions/ADR-063-fenced-ai-outbound-dispatcher.md) e [ADR-064](decisions/ADR-064-whatsapp-live-outbound-boundary.md).

`WhatsAppCloudMessagingProvider` usa endpoint Graph fixo, versão validada, HTTPS, redirect bloqueado, timeout e resposta limitada. O token não vem da fila nem da BD: `credentials_reference` é opaca e só pode ser resolvida pela interface `SecretResolver` dentro do adapter. A construção do provider não faz rede nem resolve secrets.

Depois de uma chamada live ter potencialmente começado, timeout, non-2xx ou receipt malformado são tratados como `MessagingDeliveryUnknown`. Esse estado é terminal e auditado como `ai.outbound_delivery_unknown`, sem retry automático, porque o sistema não assume idempotência externa e prefere evitar duplicados. Falhas anteriores ao efeito seguem a política de retry normal.

`startAIAutomaticOutboundRuntime` compõe provider, registry, dispatcher e queue somente quando recebe um `SecretResolver` explícito. O bootstrap opt-in usa `MountedFileSecretResolver`, que restringe referências opacas a uma root read-only, verifica containment com `realpath`, bloqueia traversal/symlink escape e limita material. A flag de outbound exige secrets montados e versão explícita da API WhatsApp; Compose não monta secrets automaticamente. Ver [ADR-065](decisions/ADR-065-opt-in-ai-outbound-worker.md).

O contrato alvo também prevê operações especializadas para resposta, extração estruturada, classificação de intenção e resumo. A seleção de modelo será feita por tarefa via configuração, sem nomes ou preços hardcoded no domínio.

## Ciclo de execução

Carregar tenant/entitlement → adquirir lease/fencing da conversa → ler epoch/version e mensagens pendentes → verificar modo → contexto selecionado (regras, estado e últimas mensagens) → provider → validar chamadas → executar tools → produzir resposta → finalizar ledger/usage e outbound intent de forma transacional → envio assíncrono com nova verificação de modo/routing.

Valores iniciais configurados: debounce 1,5s com janela máxima 5s; até 4 rondas de tool calling, 8 tools totais/turno e timeout de provider configurável até 45s por omissão. Enforce server-side, não confiar na configuração do modelo. Exceder limite encaminha para humano e regista motivo. Não manter transação DB aberta durante inferência. Fencing impede worker obsoleto de commitar nova versão ou enviar outbound antigo.

## Contratos das 14 tools

| Tool                | Validação e âmbito                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------- |
| get_business_info   | Apenas campos públicos da empresa atual                                                     |
| get_services        | Serviços ativos, paginação e campos mínimos                                                 |
| get_service_details | ID do mesmo tenant; excluir metadata interna                                                |
| get_price           | Preço efetivo, moeda e condições atuais; sem inferência                                     |
| get_business_hours  | Timezone, dia e exceções do mesmo tenant                                                    |
| get_available_slots | BookingEngine e regras de data/staff; disponibilidade não é reserva                         |
| create_booking      | Customer da conversa, confirmação explícita, serviço/slot, plano, idempotência e constraint |
| get_booking         | Apenas booking pertencente ao customer da conversa                                          |
| cancel_booking      | Ownership do customer, política, confirmação e versão                                       |
| reschedule_booking  | Ownership, política, nova disponibilidade e operação atómica                                |
| get_staff           | Só staff ativo e dados públicos pertinentes                                                 |
| create_lead         | Customer atual, input limitado, dedup por ação                                              |
| update_customer     | Apenas campos permitidos do customer atual; sem flags de consentimento inventadas           |
| human_handoff       | Muda modo, invalida epoch, notifica equipa; idempotente                                     |

Schemas estritos: `additionalProperties: false`, limites de strings/arrays e enums. TenantContext, customer, ambiente e actor são injetados pelo backend, nunca parâmetros escolhidos pelo LLM. Testar tentativas de obter booking de outro cliente do mesmo tenant, além de cross-tenant.

Apenas seis tools read-only desta tabela estão implementadas e ligadas ao runtime atual. As restantes continuam alvo de implementação e não são expostas ao provider.

## Estado, segurança e verdade

Estado estruturado validado/versionado com intent/stage/service/date/staff; resumo não é fonte de preço ou disponibilidade. Tool registry definido no servidor por capability/entitlement e fase implementada. Resposta só afirma criação/cancelamento após resultado de sucesso confirmado. Pedido explícito de humano, reclamação grave e situação não suportada levam a handoff.

UI/humano e workers usam `mode_epoch`. Takeover incrementa epoch; outbound automático antigo falha a verificação final. Envio já aceite pelo provider antes do takeover pode chegar depois; mostrar este limite e não prometer retirar mensagens em trânsito. Ação humana não pode ser anulada por retry de worker antigo.

## Sandbox

Motor e validators reais, repositories de sandbox separados dos live e providers de saída sem efeitos reais. `execution_mode` deriva do endpoint/sessão autorizada, nunca de texto da IA. Não gravar bookings/mensagens live nem enviar WhatsApp/Calendar/Stripe. Sandbox pode usar OpenAI real com orçamento de testes separado; custos reais medidos, excluídos de consumo comercial salvo política explícita. Banner inequívoco no frontend. Fixtures isoladas por tenant/test_session, com TTL.

## Ativação e avaliação

Test suite a partir de config snapshot: preço, fechado, horário, tools, idioma, injection e handoff. Asserções determinísticas em outputs estruturados e efeitos; avaliação semântica como complemento. Teste “18 EUR” não depende de frase exata. Config mudou → resultados anteriores inválidos. Falha → needs_review, com diagnóstico e repetição. Ativação verifica versão testada, channel, calendar, billing e estado tenant numa operação coordenada.

Guardar usage mesmo em timeout/falha quando provider consumiu; reconciliar estimativas. Não guardar prompts completos em logs de rotina. Integração real exige validação em staging; mocks não provam comportamento do provider. O runtime opt-in e CI verde não equivalem a autorização de produção.

## Validação do HEAD

A CI #198 validou o HEAD documentado com install frozen, migrations e seed idempotente, format/lint/TypeScript strict, unitários, integração com worker real, recovery Redis, OpenAPI, audit de dependências, Compose e Flutter completos. Esta validação não substitui staging com providers e credenciais reais.
