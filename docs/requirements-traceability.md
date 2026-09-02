# Rastreabilidade da especificação

Uma linha por secção 0–135. Cobertura desta matriz significa atribuição de responsabilidade, não cumprimento funcional. Fonte original inalterada. A fase é o início ou a consolidação principal; segurança, testes e docs aplicam-se transversalmente. APIs P1 definem convenções; endpoints só entram com os módulos. Leads começa em P4 e consolida reporting em P10. Audit base P2, completo P10; email identidade P2, notifications P8; provisioning incremental P3/P5/P9, completo P11. §102 prepara location no modelo P0/P6; UI multi-location pós-MVP. §112 é restrição de escopo já adotada.

Cada PR deve citar também os subitens da secção e anexar evidência concreta (comando/CI/teste/commit). Não fechar uma secção pelo título ou por uma única asserção.

| Secção | Requisito original | Fase principal | Responsável técnico | Evidência esperada | Estado |
|---|---|---|---|---|---|
| 0 | Instrução principal para o Codex | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 1 | Objetivo do produto | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 2 | Arquitetura geral | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 3 | Stack tecnológica | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 4 | Multi-tenancy | P2 | Identity/Tenants/Security | Auth/RBAC/RLS e cenários A/B | Planeado; não implementado |
| 5 | Roles e permissões | P2 | Identity/Tenants/Security | Auth/RBAC/RLS e cenários A/B | Planeado; não implementado |
| 6 | Estrutura de utilizadores e tenants | P2 | Identity/Tenants/Security | Auth/RBAC/RLS e cenários A/B | Planeado; não implementado |
| 7 | Indústrias e templates | P3 | Business/Onboarding | Forms, autosave, timezone, configuração e traduções | Planeado; não implementado |
| 8 | Onboarding | P3 | Business/Onboarding | Forms, autosave, timezone, configuração e traduções | Planeado; não implementado |
| 9 | Provisioning | P11 | Quality/Provisioning | E2E, retention, chaos e performance | Planeado; não implementado |
| 10 | Serviços | P3 | Business/Onboarding | Forms, autosave, timezone, configuração e traduções | Planeado; não implementado |
| 11 | Horários | P3 | Business/Onboarding | Forms, autosave, timezone, configuração e traduções | Planeado; não implementado |
| 12 | Funcionários | P3 | Business/Onboarding | Forms, autosave, timezone, configuração e traduções | Planeado; não implementado |
| 13 | Clientes finais | P4 | Messaging/Customers | Webhook assinado, dedup/outbox e recovery | Planeado; não implementado |
| 14 | Canais | P4 | Messaging/Customers | Webhook assinado, dedup/outbox e recovery | Planeado; não implementado |
| 15 | WhatsApp | P4 | Messaging/Customers | Webhook assinado, dedup/outbox e recovery | Planeado; não implementado |
| 16 | Idempotência | P4 | Messaging/Customers | Webhook assinado, dedup/outbox e recovery | Planeado; não implementado |
| 17 | Conversas | P4 | Messaging/Customers | Webhook assinado, dedup/outbox e recovery | Planeado; não implementado |
| 18 | Mensagens | P4 | Messaging/Customers | Webhook assinado, dedup/outbox e recovery | Planeado; não implementado |
| 19 | Conversation State | P5 | AI/Agents/Tools | Schema, safety, âmbito customer e sandbox | Planeado; não implementado |
| 20 | Locks de conversa | P4 | Messaging/Customers | Webhook assinado, dedup/outbox e recovery | Planeado; não implementado |
| 21 | Message batching | P4 | Messaging/Customers | Webhook assinado, dedup/outbox e recovery | Planeado; não implementado |
| 22 | Motor de IA | P5 | AI/Agents/Tools | Schema, safety, âmbito customer e sandbox | Planeado; não implementado |
| 23 | Configuração do agente | P5 | AI/Agents/Tools | Schema, safety, âmbito customer e sandbox | Planeado; não implementado |
| 24 | System prompt gerado | P5 | AI/Agents/Tools | Schema, safety, âmbito customer e sandbox | Planeado; não implementado |
| 25 | Tools disponíveis à IA | P5 | AI/Agents/Tools | Schema, safety, âmbito customer e sandbox | Planeado; não implementado |
| 26 | Regra crítica de Tool Calling | P5 | AI/Agents/Tools | Schema, safety, âmbito customer e sandbox | Planeado; não implementado |
| 27 | Validação server-side de tools | P5 | AI/Agents/Tools | Schema, safety, âmbito customer e sandbox | Planeado; não implementado |
| 28 | Booking Engine | P6 | Booking | Concorrência, invariantes, UTC/DST e UI | Planeado; não implementado |
| 29 | Bookings | P6 | Booking | Concorrência, invariantes, UTC/DST e UI | Planeado; não implementado |
| 30 | Concurrency para bookings | P6 | Booking | Concorrência, invariantes, UTC/DST e UI | Planeado; não implementado |
| 31 | Agenda interna | P6 | Booking | Concorrência, invariantes, UTC/DST e UI | Planeado; não implementado |
| 32 | Google Calendar | P7 | Calendar | OAuth, sync/reconciliation e teste real | Planeado; não implementado |
| 33 | OAuth | P7 | Calendar | OAuth, sync/reconciliation e teste real | Planeado; não implementado |
| 34 | Human Handoff | P8 | Inbox/Handoff | Takeover concorrente, reconexão e alertas | Planeado; não implementado |
| 35 | Inbox | P8 | Inbox/Handoff | Takeover concorrente, reconexão e alertas | Planeado; não implementado |
| 36 | Leads | P10 | Analytics/Admin | Ledger vs agregados e suporte auditado | Planeado; não implementado |
| 37 | Dashboard | P10 | Analytics/Admin | Ledger vs agregados e suporte auditado | Planeado; não implementado |
| 38 | Métrica de automação | P10 | Analytics/Admin | Ledger vs agregados e suporte auditado | Planeado; não implementado |
| 39 | Usage Metering | P9 | Billing/Usage | Stripe test real, limites/replay/custos | Planeado; não implementado |
| 40 | Custos internos | P9 | Billing/Usage | Stripe test real, limites/replay/custos | Planeado; não implementado |
| 41 | Cost Guard | P9 | Billing/Usage | Stripe test real, limites/replay/custos | Planeado; não implementado |
| 42 | Billing | P9 | Billing/Usage | Stripe test real, limites/replay/custos | Planeado; não implementado |
| 43 | Planos | P9 | Billing/Usage | Stripe test real, limites/replay/custos | Planeado; não implementado |
| 44 | Subscriptions | P9 | Billing/Usage | Stripe test real, limites/replay/custos | Planeado; não implementado |
| 45 | Webhooks Stripe | P9 | Billing/Usage | Stripe test real, limites/replay/custos | Planeado; não implementado |
| 46 | Limites | P9 | Billing/Usage | Stripe test real, limites/replay/custos | Planeado; não implementado |
| 47 | Overages | P9 | Billing/Usage | Stripe test real, limites/replay/custos | Planeado; não implementado |
| 48 | Admin Platform | P10 | Analytics/Admin | Ledger vs agregados e suporte auditado | Planeado; não implementado |
| 49 | Gestão de tenants | P10 | Analytics/Admin | Ledger vs agregados e suporte auditado | Planeado; não implementado |
| 50 | Impersonation | P10 | Analytics/Admin | Ledger vs agregados e suporte auditado | Planeado; não implementado |
| 51 | Audit Logs | P2 | Identity/Tenants/Security | Auth/RBAC/RLS e cenários A/B | Planeado; não implementado |
| 52 | Segurança | P2 | Identity/Tenants/Security | Auth/RBAC/RLS e cenários A/B | Planeado; não implementado |
| 53 | Segredos | P2 | Identity/Tenants/Security | Auth/RBAC/RLS e cenários A/B | Planeado; não implementado |
| 54 | Dados sensíveis | P5 | AI/Agents/Tools | Schema, safety, âmbito customer e sandbox | Planeado; não implementado |
| 55 | Prompt Injection | P5 | AI/Agents/Tools | Schema, safety, âmbito customer e sandbox | Planeado; não implementado |
| 56 | GDPR e privacidade | P11 | Quality/Provisioning | E2E, retention, chaos e performance | Planeado; não implementado |
| 57 | Soft Delete | P11 | Quality/Provisioning | E2E, retention, chaos e performance | Planeado; não implementado |
| 58 | Localização | P3 | Business/Onboarding | Forms, autosave, timezone, configuração e traduções | Planeado; não implementado |
| 59 | Internacionalização | P3 | Business/Onboarding | Forms, autosave, timezone, configuração e traduções | Planeado; não implementado |
| 60 | Moedas | P3 | Business/Onboarding | Forms, autosave, timezone, configuração e traduções | Planeado; não implementado |
| 61 | Telefone | P3 | Business/Onboarding | Forms, autosave, timezone, configuração e traduções | Planeado; não implementado |
| 62 | Storage | P4 | Messaging/Customers | Webhook assinado, dedup/outbox e recovery | Planeado; não implementado |
| 63 | Knowledge Base — Fase posterior | Pós-MVP | Extensions | Backlog explícito e fronteiras preservadas | Diferido conforme especificação |
| 64 | Webchat — futura extensão simples | Pós-MVP | Extensions | Backlog explícito e fronteiras preservadas | Diferido conforme especificação |
| 65 | Notification Service | P8 | Inbox/Handoff | Takeover concorrente, reconexão e alertas | Planeado; não implementado |
| 66 | n8n | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 67 | Event Architecture | P4 | Messaging/Customers | Webhook assinado, dedup/outbox e recovery | Planeado; não implementado |
| 68 | Queues | P4 | Messaging/Customers | Webhook assinado, dedup/outbox e recovery | Planeado; não implementado |
| 69 | Falhas | P4 | Messaging/Customers | Webhook assinado, dedup/outbox e recovery | Planeado; não implementado |
| 70 | Dead Letter / Failed Jobs | P10 | Analytics/Admin | Ledger vs agregados e suporte auditado | Planeado; não implementado |
| 71 | Observability | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 72 | Logs | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 73 | Health endpoints | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 74 | API Versioning | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 75 | Endpoints principais | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 76 | Webhook endpoints | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 77 | Frontend — páginas | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 78 | Flutter architecture | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 79 | UX | P3 | Business/Onboarding | Forms, autosave, timezone, configuração e traduções | Planeado; não implementado |
| 80 | Onboarding UX | P3 | Business/Onboarding | Forms, autosave, timezone, configuração e traduções | Planeado; não implementado |
| 81 | Test Chat | P5 | AI/Agents/Tools | Schema, safety, âmbito customer e sandbox | Planeado; não implementado |
| 82 | Testes automáticos do agente | P11 | Quality/Provisioning | E2E, retention, chaos e performance | Planeado; não implementado |
| 83 | Feature Flags | P11 | Quality/Provisioning | E2E, retention, chaos e performance | Planeado; não implementado |
| 84 | Environment | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 85 | Configuração de ambiente | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 86 | Repository | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 87 | Docker | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 88 | CI/CD | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 89 | Migrations | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 90 | Testes | P11 | Quality/Provisioning | E2E, retention, chaos e performance | Planeado; não implementado |
| 91 | Tenant Isolation Tests | P2 | Identity/Tenants/Security | Auth/RBAC/RLS e cenários A/B | Planeado; não implementado |
| 92 | Booking Race Test | P6 | Booking | Concorrência, invariantes, UTC/DST e UI | Planeado; não implementado |
| 93 | Webhook Duplicate Test | P4 | Messaging/Customers | Webhook assinado, dedup/outbox e recovery | Planeado; não implementado |
| 94 | AI Safety Tests | P5 | AI/Agents/Tools | Schema, safety, âmbito customer e sandbox | Planeado; não implementado |
| 95 | Performance | P11 | Quality/Provisioning | E2E, retention, chaos e performance | Planeado; não implementado |
| 96 | Pagination | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 97 | Search | P10 | Analytics/Admin | Ledger vs agregados e suporte auditado | Planeado; não implementado |
| 98 | Data retention | P11 | Quality/Provisioning | E2E, retention, chaos e performance | Planeado; não implementado |
| 99 | Cron jobs | P11 | Quality/Provisioning | E2E, retention, chaos e performance | Planeado; não implementado |
| 100 | Reconciliation | P11 | Quality/Provisioning | E2E, retention, chaos e performance | Planeado; não implementado |
| 101 | Produto internacional | P3 | Business/Onboarding | Forms, autosave, timezone, configuração e traduções | Planeado; não implementado |
| 102 | Multi-location — preparar schema | Pós-MVP | Extensions | Backlog explícito e fronteiras preservadas | Diferido conforme especificação |
| 103 | API Keys futuras | Pós-MVP | Extensions | Backlog explícito e fronteiras preservadas | Diferido conforme especificação |
| 104 | Webhooks para clientes — futuro | Pós-MVP | Extensions | Backlog explícito e fronteiras preservadas | Diferido conforme especificação |
| 105 | Analytics | P10 | Analytics/Admin | Ledger vs agregados e suporte auditado | Planeado; não implementado |
| 106 | Admin financeira | P10 | Analytics/Admin | Ledger vs agregados e suporte auditado | Planeado; não implementado |
| 107 | Email | P8 | Inbox/Handoff | Takeover concorrente, reconexão e alertas | Planeado; não implementado |
| 108 | Usage warnings | P9 | Billing/Usage | Stripe test real, limites/replay/custos | Planeado; não implementado |
| 109 | Suspensão | P9 | Billing/Usage | Stripe test real, limites/replay/custos | Planeado; não implementado |
| 110 | Error taxonomy | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 111 | API response errors | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 112 | Não fazer no MVP | Pós-MVP | Extensions | Backlog explícito e fronteiras preservadas | Diferido conforme especificação |
| 113 | MVP funcional obrigatório | P11 | Quality/Provisioning | E2E, retention, chaos e performance | Planeado; não implementado |
| 114 | Fluxo de exemplo completo | P11 | Quality/Provisioning | E2E, retention, chaos e performance | Planeado; não implementado |
| 115 | Arquitetura crítica a preservar | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 116 | Fonte de verdade | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 117 | Princípio de segurança fundamental | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 118 | Ordem de implementação | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 119 | README obrigatório | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 120 | Documentação técnica | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 121 | OpenAPI | P1 | Infrastructure/API | Build, health, config e contrato | Planeado; não implementado |
| 122 | Seeds de desenvolvimento | P3 | Business/Onboarding | Forms, autosave, timezone, configuração e traduções | Planeado; não implementado |
| 123 | Mock providers | P5 | AI/Agents/Tools | Schema, safety, âmbito customer e sandbox | Planeado; não implementado |
| 124 | Provider abstractions | P5 | AI/Agents/Tools | Schema, safety, âmbito customer e sandbox | Planeado; não implementado |
| 125 | Coding standards | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 126 | Não gerar apenas mockups | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 127 | Integrações sem credenciais | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 128 | Definition of Done | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 129 | Critérios finais de aceitação | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 130 | Primeira tarefa do Codex | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 131 | Regra para decisões não especificadas | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 132 | Requisitos de qualidade para geração com Codex | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 133 | Fluxo desejado de desenvolvimento | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 134 | Resultado final pretendido | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
| 135 | Princípio final | P0 | Architecture | Revisão documental/ADRs e rastreabilidade | Planeado; não implementado |
