# Cadastro inicial de canais — Phase 4 parcial

Implementa a base de `channel_connections` (§14), com RLS forçada, identidade composta por tenant e identificador externo único por modo/tipo. A readiness exige schema version 5; aplicar migrations antes de iniciar API/worker atualizados. Rollback operacional: parar a versão nova antes de restaurar código/DB compatíveis, sem apagar ligações de forma automática.

## API

- `GET /api/v1/tenants/:tenantId/channels`: últimas 100 ligações (limite total de 100 registos por tenant nesta entrega).
- `POST /api/v1/tenants/:tenantId/channels/mock`: corpo `{ "displayName": "Teste" }`; cria exclusivamente uma simulação WhatsApp.
- `POST /api/v1/tenants/:tenantId/channels/:id/disconnect`: revogação idempotente; mantém o registo e o identificador reservado. Revogações repetidas não duplicam a auditoria.

Só owner/admin acedem a estes endpoints. A API não aceita modo, tenant, número externo, metadata ou credenciais no corpo. IDs `mock:<uuid>` são gerados no servidor, sem relação com números reais. A resposta usa uma lista explícita de campos públicos e nunca inclui referências de secrets ou metadata do provider.

## Limites e segurança

Uma ligação mock ativa NÃO comprova WhatsApp conectado, não permite envio e não desbloqueia ativação do produto. Não existe endpoint para criar uma ligação live nesta entrega. Produção continua bloqueada pela configuração geral. Credenciais, ownership verification com Meta, adapter real, webhooks, receção/envio, outbox, queues, media e interface de canais permanecem por implementar. Campos live no schema são apenas preparação, não uma integração funcional.

Não criar um endpoint que aceite external_phone_id arbitrário: o provisionamento real deve primeiro provar a propriedade da conta/número. Não confiar em tenant_id de webhook ou job; o futuro ingress deve resolver ligações verificadas. Antes de qualquer envio, o worker futuro deve voltar a validar estado da ligação, tenant e permissões.

## Verificação

Novas regressões integradas na suite existente: autenticação, payload extra rejeitado, nome vazio, campos públicos, IDOR entre tenants, RLS sem contexto, IDs gerados e revogação concorrente com auditoria única. Matriz owner/admin validada em teste unitário; testes HTTP por cada papel ainda pendentes. Execução local interrompida por autorização de rede; CI deste commit deve validar Prisma, migration, lint, typecheck e testes. Não considerar a Phase 4 concluída.
