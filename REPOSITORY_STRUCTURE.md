# Estrutura Inicial do Repositório — AI Receptionist SaaS

Cria um repositório com esta estrutura base:

```text
ai-receptionist-saas/
├── SPECIFICATION.md
├── IMPLEMENTATION_PLAN.md
├── README.md
├── .gitignore
├── .editorconfig
├── .env.example
├── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
│
├── apps/
│   ├── backend/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── nest-cli.json
│   │   ├── .env.example
│   │   ├── Dockerfile
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── migrations/
│   │   │   └── seed.ts
│   │   │
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   │
│   │   │   ├── config/
│   │   │   │   ├── configuration.ts
│   │   │   │   ├── env.validation.ts
│   │   │   │   └── config.module.ts
│   │   │   │
│   │   │   ├── common/
│   │   │   │   ├── decorators/
│   │   │   │   ├── filters/
│   │   │   │   ├── guards/
│   │   │   │   ├── interceptors/
│   │   │   │   ├── middleware/
│   │   │   │   ├── pipes/
│   │   │   │   ├── errors/
│   │   │   │   ├── constants/
│   │   │   │   └── utils/
│   │   │   │
│   │   │   ├── database/
│   │   │   │   ├── database.module.ts
│   │   │   │   ├── prisma.service.ts
│   │   │   │   └── transaction.service.ts
│   │   │   │
│   │   │   ├── redis/
│   │   │   │   ├── redis.module.ts
│   │   │   │   ├── redis.service.ts
│   │   │   │   └── lock.service.ts
│   │   │   │
│   │   │   ├── queue/
│   │   │   │   ├── queue.module.ts
│   │   │   │   ├── queue.constants.ts
│   │   │   │   ├── queue.service.ts
│   │   │   │   └── processors/
│   │   │   │
│   │   │   ├── auth/
│   │   │   │   ├── auth.module.ts
│   │   │   │   ├── auth.controller.ts
│   │   │   │   ├── auth.service.ts
│   │   │   │   ├── dto/
│   │   │   │   ├── guards/
│   │   │   │   └── strategies/
│   │   │   │
│   │   │   ├── users/
│   │   │   │   ├── users.module.ts
│   │   │   │   ├── users.controller.ts
│   │   │   │   ├── users.service.ts
│   │   │   │   ├── dto/
│   │   │   │   └── entities/
│   │   │   │
│   │   │   ├── tenants/
│   │   │   │   ├── tenants.module.ts
│   │   │   │   ├── tenants.controller.ts
│   │   │   │   ├── tenants.service.ts
│   │   │   │   ├── tenant-context.service.ts
│   │   │   │   ├── tenant-resolver.service.ts
│   │   │   │   ├── dto/
│   │   │   │   └── guards/
│   │   │   │
│   │   │   ├── memberships/
│   │   │   │   ├── memberships.module.ts
│   │   │   │   ├── memberships.controller.ts
│   │   │   │   ├── memberships.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── rbac/
│   │   │   │   ├── rbac.module.ts
│   │   │   │   ├── permissions.ts
│   │   │   │   ├── roles.ts
│   │   │   │   ├── permissions.guard.ts
│   │   │   │   └── decorators/
│   │   │   │
│   │   │   ├── onboarding/
│   │   │   │   ├── onboarding.module.ts
│   │   │   │   ├── onboarding.controller.ts
│   │   │   │   ├── onboarding.service.ts
│   │   │   │   ├── provisioning.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── industries/
│   │   │   │   ├── industries.module.ts
│   │   │   │   ├── industries.controller.ts
│   │   │   │   ├── industries.service.ts
│   │   │   │   └── templates/
│   │   │   │
│   │   │   ├── services/
│   │   │   │   ├── services.module.ts
│   │   │   │   ├── services.controller.ts
│   │   │   │   ├── services.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── business-hours/
│   │   │   │   ├── business-hours.module.ts
│   │   │   │   ├── business-hours.controller.ts
│   │   │   │   ├── business-hours.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── staff/
│   │   │   │   ├── staff.module.ts
│   │   │   │   ├── staff.controller.ts
│   │   │   │   ├── staff.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── customers/
│   │   │   │   ├── customers.module.ts
│   │   │   │   ├── customers.controller.ts
│   │   │   │   ├── customers.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── faqs/
│   │   │   │   ├── faqs.module.ts
│   │   │   │   ├── faqs.controller.ts
│   │   │   │   ├── faqs.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── policies/
│   │   │   │   ├── policies.module.ts
│   │   │   │   ├── policies.controller.ts
│   │   │   │   └── policies.service.ts
│   │   │   │
│   │   │   ├── channels/
│   │   │   │   ├── channels.module.ts
│   │   │   │   ├── channels.service.ts
│   │   │   │   ├── channel.interface.ts
│   │   │   │   ├── whatsapp/
│   │   │   │   │   ├── whatsapp.module.ts
│   │   │   │   │   ├── whatsapp.controller.ts
│   │   │   │   │   ├── whatsapp.service.ts
│   │   │   │   │   ├── whatsapp.provider.ts
│   │   │   │   │   ├── whatsapp-webhook.service.ts
│   │   │   │   │   ├── whatsapp-signature.service.ts
│   │   │   │   │   └── dto/
│   │   │   │   └── webchat/
│   │   │   │       └── README.md
│   │   │   │
│   │   │   ├── conversations/
│   │   │   │   ├── conversations.module.ts
│   │   │   │   ├── conversations.controller.ts
│   │   │   │   ├── conversations.service.ts
│   │   │   │   ├── conversation-engine.service.ts
│   │   │   │   ├── conversation-state.service.ts
│   │   │   │   ├── conversation-lock.service.ts
│   │   │   │   ├── message-batching.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── messages/
│   │   │   │   ├── messages.module.ts
│   │   │   │   ├── messages.controller.ts
│   │   │   │   ├── messages.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── ai/
│   │   │   │   ├── ai.module.ts
│   │   │   │   ├── ai.service.ts
│   │   │   │   ├── ai-context-builder.service.ts
│   │   │   │   ├── prompt-builder.service.ts
│   │   │   │   ├── model-router.service.ts
│   │   │   │   ├── interfaces/
│   │   │   │   │   └── ai-provider.interface.ts
│   │   │   │   ├── providers/
│   │   │   │   │   ├── openai.provider.ts
│   │   │   │   │   └── mock-ai.provider.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── agents/
│   │   │   │   ├── agents.module.ts
│   │   │   │   ├── agents.controller.ts
│   │   │   │   ├── agents.service.ts
│   │   │   │   ├── agent-config.service.ts
│   │   │   │   ├── agent-testing.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── ai-tools/
│   │   │   │   ├── ai-tools.module.ts
│   │   │   │   ├── ai-tools.registry.ts
│   │   │   │   ├── ai-tools.executor.ts
│   │   │   │   └── tools/
│   │   │   │       ├── get-business-info.tool.ts
│   │   │   │       ├── get-services.tool.ts
│   │   │   │       ├── get-service-details.tool.ts
│   │   │   │       ├── get-price.tool.ts
│   │   │   │       ├── get-business-hours.tool.ts
│   │   │   │       ├── get-available-slots.tool.ts
│   │   │   │       ├── create-booking.tool.ts
│   │   │   │       ├── get-booking.tool.ts
│   │   │   │       ├── cancel-booking.tool.ts
│   │   │   │       ├── reschedule-booking.tool.ts
│   │   │   │       ├── get-staff.tool.ts
│   │   │   │       ├── create-lead.tool.ts
│   │   │   │       ├── update-customer.tool.ts
│   │   │   │       └── human-handoff.tool.ts
│   │   │   │
│   │   │   ├── bookings/
│   │   │   │   ├── bookings.module.ts
│   │   │   │   ├── bookings.controller.ts
│   │   │   │   ├── bookings.service.ts
│   │   │   │   ├── booking-engine.service.ts
│   │   │   │   ├── availability.service.ts
│   │   │   │   ├── booking-lock.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── calendars/
│   │   │   │   ├── calendars.module.ts
│   │   │   │   ├── calendars.service.ts
│   │   │   │   ├── interfaces/
│   │   │   │   │   └── calendar-provider.interface.ts
│   │   │   │   ├── internal/
│   │   │   │   │   └── internal-calendar.provider.ts
│   │   │   │   ├── google/
│   │   │   │   │   ├── google-calendar.provider.ts
│   │   │   │   │   ├── google-calendar.controller.ts
│   │   │   │   │   ├── google-oauth.service.ts
│   │   │   │   │   └── google-calendar-sync.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── leads/
│   │   │   │   ├── leads.module.ts
│   │   │   │   ├── leads.controller.ts
│   │   │   │   ├── leads.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── handoff/
│   │   │   │   ├── handoff.module.ts
│   │   │   │   ├── handoff.service.ts
│   │   │   │   └── handoff.events.ts
│   │   │   │
│   │   │   ├── billing/
│   │   │   │   ├── billing.module.ts
│   │   │   │   ├── billing.controller.ts
│   │   │   │   ├── billing.service.ts
│   │   │   │   ├── stripe/
│   │   │   │   │   ├── stripe.service.ts
│   │   │   │   │   ├── stripe-webhook.controller.ts
│   │   │   │   │   └── stripe-webhook.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── plans/
│   │   │   │   ├── plans.module.ts
│   │   │   │   ├── plans.controller.ts
│   │   │   │   └── plans.service.ts
│   │   │   │
│   │   │   ├── subscriptions/
│   │   │   │   ├── subscriptions.module.ts
│   │   │   │   ├── subscriptions.controller.ts
│   │   │   │   ├── subscriptions.service.ts
│   │   │   │   └── entitlement.service.ts
│   │   │   │
│   │   │   ├── usage/
│   │   │   │   ├── usage.module.ts
│   │   │   │   ├── usage.controller.ts
│   │   │   │   ├── usage.service.ts
│   │   │   │   ├── usage-meter.service.ts
│   │   │   │   ├── cost-guard.service.ts
│   │   │   │   └── cost-aggregation.service.ts
│   │   │   │
│   │   │   ├── analytics/
│   │   │   │   ├── analytics.module.ts
│   │   │   │   ├── analytics.controller.ts
│   │   │   │   ├── analytics.service.ts
│   │   │   │   └── aggregation.service.ts
│   │   │   │
│   │   │   ├── notifications/
│   │   │   │   ├── notifications.module.ts
│   │   │   │   ├── notifications.service.ts
│   │   │   │   ├── interfaces/
│   │   │   │   └── providers/
│   │   │   │
│   │   │   ├── storage/
│   │   │   │   ├── storage.module.ts
│   │   │   │   ├── storage.service.ts
│   │   │   │   └── providers/
│   │   │   │
│   │   │   ├── feature-flags/
│   │   │   │   ├── feature-flags.module.ts
│   │   │   │   └── feature-flags.service.ts
│   │   │   │
│   │   │   ├── audit/
│   │   │   │   ├── audit.module.ts
│   │   │   │   ├── audit.service.ts
│   │   │   │   └── audit.interceptor.ts
│   │   │   │
│   │   │   ├── admin/
│   │   │   │   ├── admin.module.ts
│   │   │   │   ├── admin.controller.ts
│   │   │   │   ├── admin.service.ts
│   │   │   │   ├── impersonation.service.ts
│   │   │   │   └── dto/
│   │   │   │
│   │   │   ├── events/
│   │   │   │   ├── event-bus.module.ts
│   │   │   │   ├── event-bus.service.ts
│   │   │   │   └── domain-events/
│   │   │   │
│   │   │   ├── webhooks/
│   │   │   │   ├── webhooks.module.ts
│   │   │   │   └── external-events.service.ts
│   │   │   │
│   │   │   ├── health/
│   │   │   │   ├── health.module.ts
│   │   │   │   └── health.controller.ts
│   │   │   │
│   │   │   └── jobs/
│   │   │       ├── jobs.module.ts
│   │   │       ├── usage-aggregation.job.ts
│   │   │       ├── cleanup.job.ts
│   │   │       ├── calendar-reconciliation.job.ts
│   │   │       └── billing-reconciliation.job.ts
│   │   │
│   │   └── test/
│   │       ├── unit/
│   │       ├── integration/
│   │       ├── e2e/
│   │       ├── fixtures/
│   │       └── mocks/
│   │
│   └── flutter_app/
│       ├── pubspec.yaml
│       ├── analysis_options.yaml
│       ├── .env.example
│       ├── web/
│       ├── android/
│       ├── ios/
│       ├── test/
│       ├── integration_test/
│       │
│       └── lib/
│           ├── main.dart
│           │
│           ├── app/
│           │   ├── app.dart
│           │   ├── router.dart
│           │   └── bootstrap.dart
│           │
│           ├── core/
│           │   ├── api/
│           │   │   ├── api_client.dart
│           │   │   ├── api_exception.dart
│           │   │   └── generated/
│           │   ├── auth/
│           │   ├── config/
│           │   ├── errors/
│           │   ├── localization/
│           │   ├── routing/
│           │   ├── storage/
│           │   ├── theme/
│           │   └── utils/
│           │
│           ├── shared/
│           │   ├── widgets/
│           │   ├── models/
│           │   ├── providers/
│           │   └── extensions/
│           │
│           └── features/
│               ├── auth/
│               │   ├── data/
│               │   ├── domain/
│               │   └── presentation/
│               ├── onboarding/
│               │   ├── data/
│               │   ├── domain/
│               │   └── presentation/
│               ├── dashboard/
│               ├── conversations/
│               ├── bookings/
│               ├── customers/
│               ├── services/
│               ├── staff/
│               ├── analytics/
│               ├── integrations/
│               ├── billing/
│               ├── settings/
│               └── admin/
│
├── packages/
│   ├── api-contracts/
│   │   ├── README.md
│   │   └── openapi/
│   │       └── openapi.yaml
│   │
│   └── shared-config/
│       └── README.md
│
├── infra/
│   ├── docker/
│   │   ├── backend.Dockerfile
│   │   └── README.md
│   ├── scripts/
│   │   ├── bootstrap.sh
│   │   ├── dev.sh
│   │   ├── test.sh
│   │   ├── migrate.sh
│   │   └── seed.sh
│   ├── nginx/
│   │   └── README.md
│   └── deployment/
│       ├── development/
│       ├── staging/
│       └── production/
│
├── docs/
│   ├── architecture.md
│   ├── database.md
│   ├── api.md
│   ├── multi-tenancy.md
│   ├── security.md
│   ├── ai-engine.md
│   ├── booking-engine.md
│   ├── whatsapp.md
│   ├── calendar.md
│   ├── billing.md
│   ├── observability.md
│   ├── deployment.md
│   ├── testing.md
│   │
│   └── decisions/
│       ├── README.md
│       ├── ADR-001-monorepo.md
│       ├── ADR-002-nestjs.md
│       ├── ADR-003-postgresql.md
│       ├── ADR-004-multi-tenancy.md
│       └── ADR-005-ai-tool-calling.md
│
└── .github/
    ├── workflows/
    │   ├── backend-ci.yml
    │   ├── flutter-ci.yml
    │   └── security.yml
    ├── pull_request_template.md
    └── ISSUE_TEMPLATE/

```

# Conteúdo inicial de `SPECIFICATION.md`

Cola em `SPECIFICATION.md` a especificação completa do produto que já foi definida anteriormente.

Esse ficheiro deve ser tratado como a principal fonte de requisitos do projeto.

Nunca alterar requisitos silenciosamente.

---

# Conteúdo inicial de `IMPLEMENTATION_PLAN.md`

```markdown
# Implementation Plan

## Estado
PLANNING

## Objetivo
Implementar o SaaS descrito em `SPECIFICATION.md`.

## Regra principal
Antes de implementar uma funcionalidade, consultar os requisitos relevantes em `SPECIFICATION.md`.

## Fases

### Phase 0 — Architecture
- [ ] Rever SPECIFICATION.md
- [ ] Validar arquitetura
- [ ] Criar ERD
- [ ] Criar ADRs
- [ ] Definir API contracts
- [ ] Identificar secrets e credenciais externas

### Phase 1 — Infrastructure
- [ ] Monorepo
- [ ] NestJS
- [ ] Flutter
- [ ] PostgreSQL
- [ ] Prisma
- [ ] Redis
- [ ] BullMQ
- [ ] Docker Compose
- [ ] CI

### Phase 2 — Identity & Multi-Tenancy
- [ ] Users
- [ ] Authentication
- [ ] Tenants
- [ ] Memberships
- [ ] RBAC
- [ ] Tenant isolation tests
- [ ] Audit base

### Phase 3 — Business Configuration
- [ ] Industry templates
- [ ] Services
- [ ] Business hours
- [ ] Schedule exceptions
- [ ] Staff
- [ ] FAQs
- [ ] Policies
- [ ] Agent preferences
- [ ] Onboarding

### Phase 4 — Messaging
- [ ] Customers
- [ ] Channel abstraction
- [ ] WhatsApp integration
- [ ] Webhook validation
- [ ] Idempotency
- [ ] Conversations
- [ ] Messages
- [ ] Redis locks
- [ ] Message batching
- [ ] Queues

### Phase 5 — AI Engine
- [ ] AIProvider abstraction
- [ ] OpenAI provider
- [ ] Mock provider
- [ ] AIContextBuilder
- [ ] PromptBuilder
- [ ] Model router
- [ ] Tool registry
- [ ] Tool executor
- [ ] ConversationEngine
- [ ] Conversation state
- [ ] Prompt injection protection

### Phase 6 — Bookings
- [ ] Booking schema
- [ ] Availability engine
- [ ] BookingEngine
- [ ] Internal calendar
- [ ] Booking locks
- [ ] Race-condition tests
- [ ] AI booking tools

### Phase 7 — External Calendar
- [ ] CalendarProvider abstraction
- [ ] Google OAuth
- [ ] Google Calendar adapter
- [ ] Calendar sync
- [ ] Reconciliation jobs

### Phase 8 — Inbox & Handoff
- [ ] Inbox UI
- [ ] Real-time events
- [ ] Human handoff
- [ ] Takeover
- [ ] Reactivate AI
- [ ] Customer panel
- [ ] Conversation status

### Phase 9 — Billing
- [ ] Plans
- [ ] Stripe Checkout
- [ ] Stripe subscriptions
- [ ] Stripe Customer Portal
- [ ] Stripe webhooks
- [ ] EntitlementService
- [ ] Usage metering
- [ ] Overages
- [ ] CostGuard

### Phase 10 — Analytics & Admin
- [ ] Tenant dashboard
- [ ] Daily metrics
- [ ] Admin dashboard
- [ ] Tenant management
- [ ] Impersonation
- [ ] Financial metrics
- [ ] Failed jobs UI

### Phase 11 — Security & Production
- [ ] Rate limits
- [ ] Secrets management
- [ ] Security headers
- [ ] Data export
- [ ] Data deletion
- [ ] Retention jobs
- [ ] Sentry
- [ ] Structured logging
- [ ] Health checks
- [ ] Performance tests
- [ ] E2E tests

### Phase 12 — Release
- [ ] Staging deployment
- [ ] Production deployment
- [ ] Documentation
- [ ] Backup strategy
- [ ] Recovery strategy
- [ ] Launch checklist

```

---

# Conteúdo inicial de `.gitignore`

```gitignore
# Environment
.env
.env.*
!.env.example

# Node
node_modules/
dist/
coverage/
.nest/
*.log

# pnpm
.pnpm-store/

# Prisma
apps/backend/prisma/dev.db

# Flutter / Dart
.dart_tool/
.packages
.pub-cache/
.pub/
build/
flutter_export_environment.sh

# Android
.gradle/
local.properties
key.properties
*.jks
*.keystore

# iOS/macOS
Pods/
.symlinks/
Flutter/ephemeral/
DerivedData/

# IDE
.idea/
.vscode/
*.iml

# OS
.DS_Store
Thumbs.db

# Test
test-results/
playwright-report/

# Temporary
tmp/
temp/
.cache/

# Secrets
*.pem
*.key
*.p12
credentials.json
service-account.json

```

---

# Conteúdo inicial de `.editorconfig`

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.dart]
indent_size = 2

[*.md]
trim_trailing_whitespace = false

```

---

# Conteúdo inicial do `pnpm-workspace.yaml`

```yaml
packages:
  - "apps/backend"
  - "packages/*"

```

---

# Conteúdo inicial do `package.json` raiz

```json
{
  "name": "ai-receptionist-saas",
  "private": true,
  "scripts": {
    "dev:backend": "pnpm --filter backend start:dev",
    "build:backend": "pnpm --filter backend build",
    "test:backend": "pnpm --filter backend test",
    "lint:backend": "pnpm --filter backend lint",
    "install:all": "pnpm install"
  }
}

```

---

# Conteúdo inicial de `docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: ai_receptionist
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:

```

---

# Conteúdo inicial de `.env.example` na raiz

```dotenv
NODE_ENV=development

DATABASE_URL=postgresql://app:app@localhost:5432/ai_receptionist
REDIS_URL=redis://localhost:6379

BACKEND_PORT=3000
FRONTEND_URL=http://localhost:8080
BACKEND_URL=http://localhost:3000

```

---

# Conteúdo inicial de `apps/backend/.env.example`

```dotenv
NODE_ENV=development
PORT=3000

DATABASE_URL=postgresql://app:app@localhost:5432/ai_receptionist
REDIS_URL=redis://localhost:6379

JWT_SECRET=replace_me
JWT_REFRESH_SECRET=replace_me

OPENAI_API_KEY=

STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_API_VERSION=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/api/v1/integrations/google-calendar/callback

SENTRY_DSN=

APP_URL=http://localhost:8080
API_URL=http://localhost:3000

```

---

# Conteúdo inicial de `README.md`

````markdown
# AI Receptionist SaaS

SaaS multi-tenant de atendimento automático com IA para empresas.

## Estado

Em desenvolvimento.

A especificação oficial encontra-se em:

`SPECIFICATION.md`

O plano de implementação encontra-se em:

`IMPLEMENTATION_PLAN.md`

## Stack

### Frontend
- Flutter
- Dart
- Riverpod

### Backend
- Node.js
- TypeScript
- NestJS
- Prisma

### Infraestrutura
- PostgreSQL
- Redis
- BullMQ
- Docker

### Integrações
- OpenAI
- WhatsApp Business Platform
- Google Calendar
- Stripe

## Desenvolvimento local

### Pré-requisitos

- Node.js
- pnpm
- Docker
- Flutter SDK

### Iniciar infraestrutura

```bash
docker compose up -d

````

### Backend

```bash
cd apps/backend
pnpm install
pnpm prisma migrate dev
pnpm start:dev

```

### Flutter

```bash
cd apps/flutter_app
flutter pub get
flutter run -d chrome

```

## Segurança

Nunca colocar secrets no frontend.

Nunca commitar `.env`.

Nunca permitir acesso cross-tenant.

Todas as ações críticas executadas através de IA devem ser validadas pelo backend.

## Arquitetura

Consultar:

`docs/architecture.md`

````

---

# Prompt inicial para dar ao Codex

Depois de criares o repositório e colocares nele `SPECIFICATION.md`, envia ao Codex:

```text id="codex-first-prompt"
Lê integralmente o ficheiro SPECIFICATION.md.

Este ficheiro é a fonte principal de requisitos deste projeto.

Analisa também a estrutura atual do repositório.

Antes de implementar funcionalidades de produto:

1. Revê e melhora IMPLEMENTATION_PLAN.md sem remover requisitos.
2. Cria docs/architecture.md.
3. Cria docs/database.md com o ERD completo.
4. Cria docs/multi-tenancy.md.
5. Cria docs/security.md.
6. Cria os ADRs técnicos necessários.
7. Define o schema Prisma inicial.
8. Define os módulos NestJS.
9. Define a arquitetura Flutter.
10. Define o contrato OpenAPI inicial.
11. Identifica todas as decisões que ainda precisam de ser tomadas.
12. Identifica todas as integrações que requerem credenciais externas.

Princípios obrigatórios:

- SaaS multi-tenant.
- PostgreSQL é a fonte de verdade.
- Nunca duplicar código ou workflows por cliente.
- Um único motor serve múltiplos tenants.
- Nunca confiar em tenant_id enviado pelo frontend.
- O LLM nunca tem acesso direto à base de dados.
- O LLM apenas chama tools explicitamente autorizadas.
- O backend valida todas as ações críticas.
- Bookings têm de ser protegidos contra race conditions e double booking.
- Webhooks têm de ser idempotentes.
- Mensagens devem ser processadas através de queues.
- Secrets nunca podem chegar ao Flutter.
- Todas as features devem incluir authorization e tenant isolation.
- TypeScript strict.
- Testes obrigatórios.
- Não inventar credenciais.
- Não substituir integrações reais por mocks permanentemente.
- Mocks são permitidos apenas para desenvolvimento e testes.

Depois de produzir a documentação e plano, começa pela Phase 1 do IMPLEMENTATION_PLAN.md.

Em cada fase:

implementa → executa lint → typecheck → testes → corrige → documenta.

Não avances deixando testes quebrados.

Quando precisares de escolher entre duas abordagens, prioriza:
1. segurança;
2. isolamento de tenants;
3. integridade de dados;
4. escalabilidade;
5. simplicidade;
6. testabilidade;
7. custo;
8. velocidade.

Regista decisões arquiteturais relevantes em docs/decisions/.

````

---

# Primeira milestone esperada

A primeira milestone deve conseguir executar localmente:

```text
docker compose up
        ↓
PostgreSQL
Redis

pnpm start:dev
        ↓
NestJS API

flutter run -d chrome
        ↓
Flutter Web

```

E suportar inicialmente:

```text
register
login
↓
user

create tenant
↓
tenant

membership
↓
RBAC

tenant isolation
↓
tests

```

Só depois avançar para onboarding, WhatsApp, IA e bookings.

---

# Regra importante

Não cries todos estes ficheiros vazios apenas para "cumprir a estrutura".

O Codex deve criar cada módulo à medida que for implementado.

A árvore acima representa a arquitetura alvo do projeto.

A estrutura inicial mínima deve ser:

```text
ai-receptionist-saas/
├── SPECIFICATION.md
├── IMPLEMENTATION_PLAN.md
├── README.md
├── .gitignore
├── .editorconfig
├── .env.example
├── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
├── apps/
│   ├── backend/
│   └── flutter_app/
├── packages/
├── infra/
├── docs/
│   └── decisions/
└── .github/
    └── workflows/

```

Depois o Codex expande-a fase a fase.

Isso evita dezenas de ficheiros placeholder sem qualquer implementação real.