# Deploy e operação

Estado: desenho; nenhum ambiente criado e nenhum deploy executado. Development, staging e production com DB/Redis/storage/Stripe/WhatsApp/secrets separados (§84).

## Topologia

Flutter build servido por CDN/proxy; API HTTPS e workers em containers separados com utilizador não-root; PostgreSQL gerido com backups e Redis privado. Sem acesso direto do Flutter a DB ou serviços de provider. Docker Compose local inclui backend, worker, Postgres e Redis; Flutter separado. Hosting e região a decidir antes de staging; residência/latência/custo são critérios documentados, não escolhidos implicitamente.

## Release

Build imutável por commit, imagem e lockfiles fixados; migrations em job único com role própria e backup prévio. Expand/contract para mudanças incompatíveis. Deploy staging → smoke/E2E → revisão → produção autorizada → monitorização → rollback de aplicação se necessário. Rollback de DB é forward-fix/restauro planeado, não `down` destrutivo automático. Não incluir credencial de migration no container runtime.

## Health e observabilidade

`/health/live` verifica processo; `/health/ready` verifica DB/Redis e capacidade local crítica; `/health` agrega estado sanitizado. Dependência de IA externa não torna liveness negativa. Workers expõem heartbeat/backlog. Logs JSON, request_id/correlation_id/tenant_id, redaction; Sentry sanitizado, métricas de latência, falhas, queue age, retries, dead letters, provider cost, outbox lag, watch expiry e sync age.

Alertas com responsável/runbook para fila parada, perda de dedupe, token revogado, budget excedido, sync atrasado e erro de cobrança. Payload de job visível no admin é sanitizado. Retry/discard requer permissão e audit.

## Backups e manutenção

Proposta antes do primeiro cliente: PITR, backups diários cifrados, restore test mensal; alvos RPO <=15min/RTO <=4h sujeitos ao hosting e ensaio. Não são garantias atuais. Segredos/chaves de decriptação recuperáveis por processo separado. Retenção de backups alinhada com privacidade; nenhum dado de produção em fixtures.

Schedulers têm lock/idempotência persistente: agregação de uso/custos, subscriptions sync, calendar reconciliation/watch renewal, outbox recovery, cleanup/retention e storage temporário. Perda de Redis recupera pendentes via PostgreSQL.

## Troubleshooting previsto

| Sintoma | Verificação e recuperação |
|---|---|
| Readiness falha | DB/Redis, pool/roles/migrations e config; não reiniciar cegamente |
| Webhook ACK sem resposta | external_event → outbox → queue → mode/entitlement → outbound_attempt |
| Duas respostas lógicas | Dedupe/consumer receipt/action key; investigar antes de retry |
| Booking conflito | resource/ocupação/buffers/timezone; não remover constraint |
| Calendar desligado | OAuth revoked/expiry/watch/sync token; reconectar com owner autorizado |
| Pagamento pendente | Evento Stripe e reconciliação; redirect não prova pagamento |
| Tenant vê dados errados | Incidente: restringir acesso, preservar audit, verificar contexto/cache/RLS |

Os comandos concretos de runbook serão adicionados com os serviços que os implementam.
