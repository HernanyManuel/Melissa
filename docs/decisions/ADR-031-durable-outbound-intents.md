# ADR-031 — Intenções outbound duráveis (schema 16)

Estado: aceite como fundação incremental, não como envio concluído.

## Decisão

Antes de ligar o contrato do ADR-030 ao transporte, persistir uma intenção imutável em `outbound_intents`. O UUID `id`, gerado no servidor, será a identidade estável da tentativa no provider. A chave de pedido do cliente é distinta e única por tenant/ator; repetir a chave não pode criar uma segunda intenção, mesmo com concorrência. O futuro serviço deve devolver o registo existente se o conteúdo coincidir ou um conflito auditado se divergir.

RLS forçada limita leitura/inserção ao tenant da transação. FKs compostas impedem associar uma conversa ou membro de outra empresa. A função runtime não possui UPDATE/DELETE: conteúdo, identidade e vínculo não podem mudar entre retries. O índice de histórico começa pelo tenant. Apenas o provider `mock` é admitido nesta versão.

Intenção não é mensagem enviada, recebida pelo provider ou entregue ao cliente. Não se cria evento inbound fictício para satisfazer o modelo atual de mensagens. O futuro estado de dispatch será separado do conteúdo imutável. Não há descoberta global, fila ou consumidor desta tabela neste incremento.

## Segurança e limites

O contexto SQL não substitui autenticação/RBAC. A existência de membership não comprova que está ativa nem permite envio: o futuro serviço deve validar sessão, papel, conversa, canal mock ativo e cliente não arquivado, sob os locks existentes. O consumidor deve revalidar antes de chamar o provider. Nenhuma API ou serviço de produto insere intenções ainda.

Não há snapshot de telefone nem credenciais na intenção; a resolução e a política para alterações do destinatário devem ser definidas antes do consumidor. O conteúdo é dado pessoal: não deve ser registado em logs. Retenção, eliminação autorizada, quotas, auditoria transacional, replay HTTP, retries, estados de entrega, UI e adapter live continuam pendentes. A ausência de UPDATE/DELETE runtime não representa uma política de retenção concluída.

O limite SQL é 4096 caracteres e rejeita vazio/espaços; a validação de entrada deve ainda rejeitar texto composto apenas por outros caracteres de whitespace. Não há promessa de exactly-once de um provider externo. A memória do mock continua não durável.

## Validação e rollout

Testes PostgreSQL com runtime não proprietário: persistência entre clientes, rollback, RLS sem contexto/A-B, FKs cross-tenant, payload inválido, provider live recusado, imutabilidade e unicidade concorrente. Sem chamadas de rede ao provider.

Migration transacional com lock/statement timeouts; readiness exige schema 16. Requer rollout coordenado com API/worker: a versão antiga deixa de estar ready após a migration. Não executar automaticamente em produção. Sem merge, deploy ou ativação de envio.
