# Estratégia de testes e evidência

Esta entrega verifica documentação/contratos, não a aplicação. Cada execução futura regista commit, comando, ambiente, resultado e limitações. Testes só com mocks não provam constraints, RLS, OAuth ou cobrança.

| Área | Prova exigida | Fase |
|---|---|---|
| Bootstrap | Checkout limpo, lockfiles, health/readiness, API+worker+DB+Redis; Flutter build | P1 |
| Identity | Register/login/verify/reset, refresh replay, revogação, último owner, CSRF e sem enumeração | P2 |
| Tenant | A/B em CRUD, nested IDs, queries, raw repository, RLS com runtime role, pool/contexto ausente | P2 e cada módulo |
| UX/config | Autosave/reload/resume, forms com erro, six locales, teclado, mobile/desktop, permission states | P3 e cada feature |
| Messaging | Assinatura, batches, duplicados concorrentes, outbox crash/Redis down, status fora de ordem | P4 |
| AI | Schema tools, customer scope, injection, preços reais das tools, teto orçamento, timeout, sandbox | P5 |
| Booking | Corrida sobre PostgreSQL real, buffers/DST, recurso default, reschedule rollback, alterações horário | P6 |
| Google | State replay, 410/full sync, token revogado, watch expiry, conflitos, testes reais controlados | P7 |
| Handoff | Corrida entre worker e takeover; epoch invalida intenção; sockets A/B; cursor reconexão | P8 |
| Billing | Stripe test real, duplicação/ordem, quotas atómicas, overage idempotente, grace e recuperação | P9 |
| Analytics/admin | Agregação vs ledger, moedas/períodos, RBAC admin, suporte expira, retries auditados | P10 |
| Release | E2E §113, injection §94, purge/export, backup/restore, security scanning e carga | P11/P12 |

## Pipeline

Backend: formatter/lint → typecheck strict → unit → integration com PostgreSQL/Redis reais → build. Flutter: format check → analyze strict → widget tests → integration flows → web build. OpenAPI export comparado ao versionado e cliente regenerado sem diff inesperado. Security/dependency/secret checks. Teste de migration desde DB vazia e upgrade de baseline.

Migrations/RLS/exclusão não podem ser provadas por SQLite ou repositories mock. Testes de concorrência usam transações/conexões independentes com barreira de arranque, não chamadas em sequência.

## E2E do produto

Signup → verificar email → criar tenant → serviços/horários/FAQs/políticas → WhatsApp teste + agenda → Stripe test → sandbox → ativar → inbound → resposta/tool → booking → sync → UI → takeover → resposta humana → reativar IA. Fixtures Barbearia Central: Corte 18/30min, Barba 12/20min, Combo 27/45min, semana 09–19, sábado 09–14, domingo fechado e FAQs §122. Nunca seed de admin com password fixa em produção.

## Performance e resiliência

Targets §95: p95 API normal <500ms e ACK webhook <1s. Perfil inicial proposto: 100 tenants, 50 requests/s durante 10min, mistura read/write e burst webhook; registar hardware, dataset, concurrency, p95/p99/erros e backlog. Não extrapolar para 10.000 tenants sem ensaio progressivo. IA medida separadamente (fila/provider/total). Fairness por tenant sob burst.

Injetar queda antes/depois de commit, perda de Redis, lease expiry, worker duplicado, provider timeout após efeito, reorder/replay e revogação. Restore verifica contagens e invariantes de ledger/booking, não só disponibilidade do servidor.
