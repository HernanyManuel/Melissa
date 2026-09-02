# Implementation Plan — Melissa

## Controlo de escopo

Fonte: `SPECIFICATION.md`, secções 0–135, commit `c2324fe76dd5d8ec6a426403068fd8b50e2f0a3d`. Estado: Phase 1 validada em CI; Phase 2 implementada e em validação no PR #3. Ver `docs/phase-2.md` para escopo, provas e limites. Os gates completos de release continuam obrigatórios. A especificação e a estrutura original permanecem inalteradas.

Cada item da [matriz](docs/requirements-traceability.md) tem fase, responsável técnico e evidência esperada. “Planeado” não significa implementado. Uma secção com múltiplos requisitos só fecha quando todos os seus critérios forem satisfeitos. Requisitos futuros ficam explicitamente diferidos, nunca eliminados.

## Milestones e gates

| Fase / sprint | Entrega e dependências | Critério de saída |
|---|---|---|
| P0 / preparação | Arquitetura, ERD, API inicial, UX, ADRs, rastreabilidade, credenciais e riscos | Documentos coerentes e revistos; decisões pendentes identificadas |
| P1 / S1 | Monorepo, NestJS API/worker, Flutter shell, PostgreSQL, Redis, Docker, lint, CI | Checkout limpo instala; compose saudável; API live/ready; Flutter Web compila; pipeline real verde |
| P2 / S1 | Users, auth, tenants, memberships, RBAC, sessions, audit base, primeira migration e RLS | Registar, autenticar, criar e trocar empresa; testes A/B impedem IDOR e FK cruzada; sessões revogáveis |
| P3 / S2 | 12 passos de onboarding, autosave, templates, serviços, horários/exceções, staff, FAQs, políticas, preferências | Utilizador retoma noutro login; formulários e seis idiomas; validações server-side; ativação bloqueada até dependências reais |
| P4 / S3 | Customers, canais, WhatsApp, inbox de dados, mensagens, outbox, queues, debounce, storage de media | Assinatura inválida rejeitada; webhook repetido não duplica mensagem/job lógico; retry recupera falha após commit |
| P5 / S4 | AIProvider, OpenAI/mock, contexto, tools, estados, versões, sandbox, testes iniciais do agente | Resposta fundamentada em tools; orçamento e ciclo limitados; sandbox sem escrita/envio live; booking tools só ativas após P6 |
| P6 / S5 | BookingEngine, recursos, buffers, disponibilidade, calendário interno, ações manuais/IA | Corrida de requests produz uma reserva; DST e funcionário opcional cobertos; cancelamento/remarcação atómicos |
| P7 / S6 | Google OAuth, refresh, watch, busy intervals, sync e reconciliação | Tokens revogados tratados; retry não duplica evento; conflitos externos são visíveis; credenciais reais de teste verificadas |
| P8 / S7 | Inbox completo, WebSocket, takeover, reativação, notificações in-app/email | Após takeover nenhum novo envio automático é autorizado; reconexão recupera eventos; isolamento nos canais real-time |
| P9 / S8 | Stripe, planos, subscriptions, entitlements, ledger de usage, overages, warnings, CostGuard | Checkout test real, webhook duplicado/fora de ordem, limites concorrentes e recuperação de cobrança testados |
| P10 / S9 | Analytics agregados, dashboard, custos, admin, auditoria completa, suporte e jobs falhados | Métricas reconciliáveis; suporte temporário auditado; nenhum acesso administrativo implícito |
| P11 / S10 | Provisioning automático completo, suites do agente, segurança, retenção, export, performance, E2E | Critérios §§90–95 e 129 verificados; falhas injetadas e restauro ensaiados; core operacional sem ação manual do operador |
| P12 / S10 | Staging, release, runbooks, backups, observabilidade, produção | Checklist de release aprovada, testes de integrações reais, rollback/restore demonstrados e deploy autorizado |

P1 e P2 formam a primeira milestone executável. Não estimar datas antes de medir esta entrega. P11 reforça segurança já exigida em cada módulo; não adia isolamento ou autorização para o fim.

## Dependências entre fases

- A interface de EntitlementService, o registo de usage e os eventos de auditoria nascem com os primeiros consumidores; cobrança e reconciliação completas chegam em P9. Em desenvolvimento, fixtures explícitas; em produção, ausência de entitlement bloqueia ativação.
- P3 guarda configuração; P5 permite testar; ativação live só após channel, agenda, subscrição e testes válidos. Não mostrar onboarding como concluído só porque o formulário terminou.
- P5 regista schemas das 14 tools. As tools de booking recusam execução até P6 estar implementada; não retornam sucesso fictício.
- Consentimento e preferências de retenção entram no respetivo modelo; jobs completos em P11.
- Auditoria, observabilidade, rate limits e segurança são transversais desde P1/P2.

## Decomposição imediata de P1 e P2

1. Fixar versões de Node/pnpm/Nest/Prisma/Postgres/Redis/Flutter; criar lockfiles, configs strict, formatter e lint.
2. Criar `apps/backend` com entrypoints API e worker; config validada; logs com redaction; health separado de readiness; error envelope; Swagger em dev/staging.
3. Criar compose com PostgreSQL/Redis/API/worker, healthchecks e volumes; frontend separado. Segredos apenas em ambiente; serviços de dados expostos só em loopback no desenvolvimento.
4. Criar Flutter shell com tema, navegação, localization pt/en/es/fr/de/it, loading/empty/error, login e estrutura de empresas; sem autenticação simulada permanente.
5. Introduzir primeira migration de identidade/tenant; credencial de migration separada de runtime; RLS; FKs compostas; seeds idempotentes só em desenvolvimento.
6. Implementar auth e refresh rotation, recuperação, verificação de email, memberships/invites, permissões e tenant context.
7. Ligar Flutter às APIs reais; testar login/refresh/logout, seleção de tenant e bloqueios de acesso.
8. CI com lint/typecheck/unit/integration/build e Flutter analyze/test/build. Verificar installation e comandos do README num checkout limpo.

## Definition of Done por módulo

- [ ] Referências às secções e subrequisitos no PR.
- [ ] Backend, validação, authorization, tenant isolation e invariantes de dados.
- [ ] Frontend ligado, responsivo, acessível, loading/empty/error/success e traduções.
- [ ] Migrations e rollback operacional planeados; contratos e cliente atualizados.
- [ ] Testes relevantes executados; logs sanitizados e documentação mínima.
- [ ] Sem credenciais no repo; integração sem credenciais tem adapter, mock e configuração documentados.
- [ ] Commit lógico, PR revisável, resultado dos comandos e limitações verdadeiros.

## Release v1

Usar §129 integralmente como checklist; associar cada critério a execução CI/staging e commit. Nenhuma feature marcada completa com base apenas em mocks quando exige integração real. O [plano de testes](docs/testing.md) detalha as provas.

## Fora do MVP, preservado

Apps nativas distribuídas, CRM avançado, RAG complexo, white label, outros canais, Outlook, marketplace, SSO enterprise, voice e pagamentos de bookings (§112). Webchat permanece extensão pós-core (§64). Multi-location, API keys e webhooks de clientes têm pontos de extensão definidos (§§102–104), mas não são promessas de funcionalidades já disponíveis.

## Continuidade

Atualizar `docs/PROJECT_STATUS.md` em cada PR: commit de base, entregue, verificado, bloqueios, próximo passo. Trabalhar em branches `feature/*`; merge separado da criação do PR. Não avançar uma fase funcional com os seus testes quebrados.
