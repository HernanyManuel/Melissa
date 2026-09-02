# Isolamento multi-tenant

Requisitos §§4–6, 27, 46, 50–56, 91, 117. Defesa em camadas: autenticação, membership ativa, permissão, filtros explícitos, foreign keys compostas e RLS.

## Contexto de acesso

O access token identifica utilizador/sessão. `X-Tenant-Id` é apenas um seletor de empresa: o backend verifica membership ativa na DB, estado do tenant e permissão antes de criar TenantContext imutável. Nunca copiar o header para a DB sem autorização. `/tenants/:id` valida membership no ID da rota; se houver seletor divergente, rejeita. `/tenants` lista exclusivamente memberships do utilizador autenticado.

Mudança de empresa invalida caches/providers/subscrições WebSocket do Flutter. Tokens antigos não preservam uma membership removida. Revalidar sessões e memberships em operações críticas e na ligação/renovação real-time.

Webhooks: validar provider e resolver conexão por identificador externo único; ignorar qualquer tenant arbitrário no payload. Worker carrega a conexão/evento persistido e constrói novo contexto; não confiar numa string recebida de uma fila externa.

## PostgreSQL

Runtime sem ownership, SUPERUSER ou BYPASSRLS; migration usa credencial separada. Ativar ENABLE e FORCE ROW LEVEL SECURITY nas tabelas de negócio. Política de leitura e escrita usa contexto transacional (`set_config(..., true)` parametrizado) com tenant; sem contexto, negar. Não usar SET persistente no pool. Um serviço de transação encapsula toda consulta dependente de tenant no mesmo connection/transaction client.

As FKs `(tenant_id, parent_id)` apontam a `UNIQUE(tenant_id, id)` do parent. `tenant_id NOT NULL` em entidades empresariais. RLS é defesa adicional: filtros/authorization continuam necessários; a aplicação com credencial de runtime comprometida não é contida apenas por um parâmetro de sessão.

A documentação PostgreSQL explica que owners normalmente contornam RLS e que roles privilegiadas continuam a fazê-lo; daí a separação de credenciais e o uso de FORCE ([referência](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)).

## Bootstrap e âmbito global

Users/sessions são globais e acessíveis apenas ao módulo de identidade; não há endpoint que enumere utilizadores. Membership lookup usa repository restrito ao user autenticado antes de entrar no contexto tenant. Criar tenant + membership owner numa transação de bootstrap dedicada; validar actor, impedir atribuição de roles de plataforma e auditar.

Templates e planos são catálogos globais com leitura controlada. Eventos de provider ainda não resolvidos entram em inbox de ingress restrita, não em tabelas de tenant sem contexto. Relatórios de plataforma usam serviços administrativos próprios, credencial restrita a read models e auditoria; nenhum endpoint público aceita `bypass_tenant=true`.

## Matriz inicial de roles

| Capacidade | Owner | Admin | Manager | Staff | Viewer |
|---|---|---|---|---|---|
| Ler dados operacionais | Sim | Sim | Sim | Sim, âmbito autorizado | Sim |
| Serviços/horários/staff | Sim | Sim | Sim | Não | Não |
| Responder/assumir/reativar | Sim | Sim | Sim | Sim | Não |
| Reservas | Sim | Sim | Sim | Sim, recursos autorizados | Leitura |
| Billing e exclusão tenant | Sim | Não por defeito | Não | Não | Não |
| Integrações e settings | Sim | Sim | Leitura | Não | Leitura limitada |
| Memberships | Sim | Sim, sem elevar a owner | Não | Não | Não |

Permissões independentes das roles. Ownership transfer e remoção do último owner exigem operação específica, transação e reautenticação; não permitir tenant sem owner. Notas internas e dados financeiros têm permissões próprias. Staff associado a user é opcional; cliente final não é user da plataforma.

`platform_support` não recebe acesso automático a dados de clientes. Sessão de suporte limitada a tenant, motivo, ator real, prazo e permissões; banner permanente, logout/expiração e audit. `platform_super_admin` também passa por guard e reautenticação em ações críticas.

## Provas obrigatórias

Tenant A/B: GET/PATCH/DELETE, filtros, pesquisa, IDs filhos de B em requests de A, FKs cruzadas, exports/media assinada, caches, jobs, analytics e eventos WebSocket. Pool reutilizado entre A/B e contexto ausente devem negar acesso. Testar com role real de runtime; testes como owner não provam isolamento. Roles reduzidas/revogadas perdem acesso ativo; proteção deve sobreviver a retries e operações administrativas.
