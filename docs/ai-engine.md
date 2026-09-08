# Motor de conversação e IA

Pipeline partilhado por todos os tenants; configuração versionada, contexto mínimo e ferramentas explícitas. A IA interpreta linguagem e propõe intenções; o backend valida e executa ações determinísticas. O modelo nunca acede diretamente ao PostgreSQL, Redis, storage ou credenciais.

## Estado atual

`AIProvider` define o contrato vendor-neutral de completion. `AIGateway` valida contexto e respostas, limita tool calls e rejeita tools não autorizadas. `MockAIProvider` permite testes sem rede. O adapter opt-in `OpenAIResponsesProvider` traduz o contrato para a Responses API, com timeout, resposta limitada, `store: false`, tools estritas e erros fechados. Ver [ADR-053](decisions/ADR-053-ai-provider-gateway-boundary.md) e [ADR-054](decisions/ADR-054-openai-responses-adapter.md). Ainda não existem execução de tools, persistência de estado, integração com conversas ou UI; nenhuma chamada OpenAI real foi efetuada.

### Configuração do provider

- `AI_PROVIDER=disabled` é o default seguro.
- `AI_PROVIDER=mock` ativa somente o provider determinístico local.
- `AI_PROVIDER=openai` exige `OPENAI_API_KEY` e `OPENAI_MODEL` server-side.
- `OPENAI_TIMEOUT_MS` aceita 1000–60000 e usa 45000 por omissão.

Não existe fallback automático para mock. O endpoint OpenAI é fixo para impedir que configuração transforme este transporte num cliente HTTP arbitrário.

### Registry e execução de tools

`ToolRegistry` mantém o catálogo server-side com schema, efeito, capabilities, validator e handler. `ToolExecutor` revalida a resposta do provider, injeta tenant/customer/conversation e modo de execução confiáveis, gera idempotency key por turno/call e devolve somente resultados ou códigos de erro sanitizados. Escritas e handoff exigem suporte declarado a idempotência; execução é sequencial, limitada a oito calls e sujeita a timeout. Ver [ADR-055](decisions/ADR-055-server-owned-tool-registry.md).

O registry/executor ainda não contém os 14 handlers de domínio e não está ligado ao worker de conversações. Portanto, este incremento não permite à IA consultar ou alterar dados reais.

### Primeiras tools de leitura

Foram registados handlers para `get_business_info`, `get_services`, `get_service_details`, `get_price`, `get_business_hours` e `get_staff`. Todos usam schemas fechados e uma porta `BusinessToolReader`; o adapter Prisma abre uma transação curta com RLS, aplica o tenant do contexto e devolve apenas campos públicos mínimos. Preços são strings decimais, serviços inativos/arquivados e staff inativo são excluídos. Ver [ADR-056](decisions/ADR-056-tenant-scoped-business-read-tools.md).

Os handlers não foram ligados ao worker de conversações. A existência deste código não ativa IA nem acesso a dados em produção.

### Construção de contexto

`AIContextBuilder` mantém a política de sistema estática e coloca perfil, preferências, políticas, FAQs, serviços e dados mínimos do cliente num bloco JSON marcado como não confiável. `PrismaAIContextSource` exige a associação tenant/conversation/customer sob RLS. Não inclui telefone, email, notas, consentimentos, credenciais ou metadata operacional. O contexto usa até 12 mensagens recentes, trunca campos e reduz listas até respeitar um orçamento de aproximadamente 24 mil caracteres. Ver [ADR-057](decisions/ADR-057-minimal-untrusted-ai-context.md).

O modo live exige `AI_ACTIVE`; sandbox pode preparar contexto pausado sem ativar a conversa. Delimitação de dados não substitui a autorização server-side das tools nem torna o sistema imune a prompt injection.

O contrato alvo também prevê operações especializadas para resposta, extração estruturada, classificação de intenção e resumo. A seleção de modelo será feita por tarefa via configuração, sem nomes ou preços hardcoded no domínio.

## Ciclo de execução

Carregar tenant/entitlement → adquirir lease da conversa → ler epoch/version e mensagens pendentes → verificar modo → contexto selecionado (regras, resumo, estado e últimas mensagens) → reservar orçamento → provider → validar chamadas → executar tools → produzir resposta → persistir estado, usage e outbound intent → envio assíncrono com nova verificação de modo.

Valores iniciais propostos/configuráveis: debounce 1,5s com janela máxima 5s; até 4 rondas de tool calling, 8 tools totais/turno, timeout total 45s. Enforce server-side, não confiar na configuração do modelo. Exceder limite encaminha para humano e regista motivo. Não manter transação DB aberta durante inferência. Lease renovável com token/fencing; worker que perde lease não pode commitar nova versão.

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

## Estado, segurança e verdade

Estado estruturado validado/versionado com intent/stage/service/date/staff; resumo não é fonte de preço ou disponibilidade. Tool registry definido no servidor por capability/entitlement e fase implementada. Resposta só afirma criação/cancelamento após resultado de sucesso confirmado. Pedido explícito de humano, reclamação grave e situação não suportada levam a handoff.

UI/humano e workers usam `mode_epoch`. Takeover incrementa epoch; outbound automático antigo falha a verificação final. Envio já aceite pelo provider antes do takeover pode chegar depois; mostrar este limite e não prometer retirar mensagens em trânsito. Ação humana não pode ser anulada por retry de worker antigo.

## Sandbox

Motor e validators reais, repositories de sandbox separados dos live e providers de saída sem efeitos reais. `execution_mode` deriva do endpoint/sessão autorizada, nunca de texto da IA. Não gravar bookings/mensagens live nem enviar WhatsApp/Calendar/Stripe. Sandbox pode usar OpenAI real com orçamento de testes separado; custos reais medidos, excluídos de consumo comercial salvo política explícita. Banner inequívoco no frontend. Fixtures isoladas por tenant/test_session, com TTL.

## Ativação e avaliação

Test suite a partir de config snapshot: preço, fechado, horário, tools, idioma, injection e handoff. Asserções determinísticas em outputs estruturados e efeitos; avaliação semântica como complemento. Teste “18 EUR” não depende de frase exata. Config mudou → resultados anteriores inválidos. Falha → needs_review, com diagnóstico e repetição. Ativação verifica versão testada, channel, calendar, billing e estado tenant numa operação coordenada.

Guardar usage mesmo em timeout/falha quando provider consumiu; reconciliar estimativas. Não guardar prompts completos em logs de rotina. Integração real exige validação em staging; mocks não provam comportamento do provider.
