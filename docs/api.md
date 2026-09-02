# API e contratos

Base `/api/v1`; health e webhooks mantêm paths de §§73/76 fora da base. O [OpenAPI inicial](../packages/api-contracts/openapi/openapi.yaml) descreve identidade, tenants, serviços, disponibilidade e reservas como proposta não implementada. O catálogo abaixo conserva as restantes APIs; schemas detalhados chegam com cada módulo. Não confundir contrato planeado com servidor disponível.

OpenAPI 3.0.3 escolhido por interoperabilidade, sem depender de features recentes. Na P1, NestJS exporta documento via SwaggerModule.createDocument e CI verifica drift; `/api/docs` em dev/staging, restrito/desativado em produção ([NestJS](https://docs.nestjs.com/openapi/introduction), [OpenAPI](https://spec.openapis.org/oas/v3.0.3.html)).

## Convenções

- JWT Bearer em endpoints autenticados; refresh/logout por cookie seguro e CSRF. Token opaco de refresh nunca retorna em JSON na Web.
- `X-Tenant-Id` obrigatório nos recursos scoped; apenas seletor validado com membership. Não exigido em auth/list/create tenant. IDs na rota não dispensam autorização.
- UUIDs; timestamps RFC3339 UTC, timezone IANA separado; money string decimal + currency ISO. Datas de agenda locais explicitamente identificadas.
- Listas `{data:[], next_cursor:null|string}`; `limit` 1–100, default 25. Cursor opaco vinculado aos filtros/ordenação. Sem offsets para messages/usage/audit.
- Criações críticas têm `Idempotency-Key` (16–128 caracteres), scoped tenant/actor/operação; retenção inicial 24h, resposta repetida preservada; payload diferente dá 409.
- ETag em recursos mutáveis; `If-Match` para PATCH/remarcar/cancelar. Versão divergente = 412; atualização é atómica.
- Error `{error:{code,message,request_id,details?}}`, nunca stack. UI traduz por code, não faz parsing da mensagem.

| HTTP | Códigos exemplificativos |
|---|---|
| 400 | VALIDATION_ERROR, INVALID_CURSOR |
| 401 | UNAUTHENTICATED, SESSION_EXPIRED |
| 403 | PERMISSION_DENIED, SUBSCRIPTION_INACTIVE, PLAN_LIMIT_EXCEEDED |
| 404 | TENANT_NOT_FOUND, BOOKING_NOT_FOUND; ocultar existência fora do âmbito |
| 409 | SLOT_UNAVAILABLE, IDEMPOTENCY_CONFLICT, CONVERSATION_LOCKED |
| 412 | VERSION_CONFLICT |
| 429 | RATE_LIMITED; Retry-After |
| 503 | INTEGRATION_DISCONNECTED, TEMPORARILY_UNAVAILABLE |

## Catálogo previsto

Todos os paths seguintes usam `/api/v1` salvo indicação explícita. CRUD = GET coleção, POST coleção, GET/PATCH/DELETE `/{id}` com permissões separadas.

| Domínio | Operações obrigatórias/adicionais | Gate |
|---|---|---|
| Auth | POST register/login/logout/refresh/forgot-password/reset-password; GET me; POST verify-email/resend-verification | P2 |
| Tenants | CRUD tenants; GET memberships; POST invitations; aceitar convite e gerir roles com guard | P2 |
| Onboarding | GET onboarding; PATCH business/services/hours/staff/faqs/personality; PATCH policies adicional; POST activate | P3/P11 |
| Configuração | CRUD services/staff/faqs/policies; GET/PATCH business-hours e exceptions; GET/PATCH settings | P3 |
| Customers | CRUD customers, pesquisa name/phone/email, notas/tags, automation-block | P4 |
| Conversations | GET coleção/detalhe/messages; POST messages/takeover/reactivate-ai/close; read cursor | P4/P8 |
| Agents | Config draft/publish/history, POST test-sessions/messages, GET test-runs/results | P5 |
| Bookings | GET coleção/detalhe; POST criação/cancel/reschedule; PATCH campos editáveis; GET availability | P6 |
| Integrations | GET integrations; POST whatsapp/connect; DELETE whatsapp; POST google-calendar/connect; GET callback; DELETE google-calendar | P4/P7 |
| Billing | GET subscription/usage; POST checkout-session/customer-portal; GET plans | P9 |
| Analytics | GET overview/conversations/bookings/services/usage | P10 |
| Admin | GET tenants/subscriptions/jobs/incidents/usage/audit; tenant suspend/reactivate; support sessions; jobs retry/discard | P10 |
| Privacy | POST exports/deletion requests; GET job status; consent history | P11 |
| Health (sem prefixo) | GET /health, /health/live, /health/ready | P1 |
| Webhooks (sem prefixo) | GET/POST /webhooks/whatsapp, POST /webhooks/stripe, POST /webhooks/google | P4/P7/P9 |

Policies adicionais e operações auxiliares fecham requisitos descritos em prosa, não substituem os paths originais. DTOs de staff/customers/conversations/billing e admin serão definidos no PR do módulo antes do frontend consumidor.

## Real-time

WebSocket autenticado por sessão, sem token em query string. Backend valida membership e subscreve apenas canais permitidos; rooms não escolhidas arbitrariamente pelo cliente. Envelope: event_id, type, tenant_id, aggregate_id, version, occurred_at, data mínima. Eventos message.created/delivery_updated, conversation.mode_changed, booking.updated, notification.created. Cursor e REST reconciliam gaps; reconexão não implica estado já atualizado. Revalidar membership após revogação; heartbeat/backoff e expiração controlados.

## Fluxo de reserva

GET availability → POST bookings com Idempotency-Key → 201 booking + sync_status/ETag, ou 409. Cliente não envia tenant_id no body. PATCH não altera start/end: usar reschedule para preservar invariantes. Customer/staff/service IDs sempre revalidados pelo domínio.
