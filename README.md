# Melissa

Plataforma SaaS multi-tenant de operações conversacionais: atendimento WhatsApp, assistente com ferramentas autorizadas, agenda, equipa, subscrições e analytics.

## Estado real

Phase 0 — arquitetura documentada, proposta para revisão. Ainda não existe aplicação executável, migrations aplicadas, integração configurada ou teste funcional aprovado. Os documentos descrevem o sistema a construir, não funcionalidades já entregues.

A [especificação original](SPECIFICATION.md) é a fonte de requisitos. A [estrutura original](REPOSITORY_STRUCTURE.md) está preservada. O [plano de implementação](IMPLEMENTATION_PLAN.md) define a sequência; a [matriz de requisitos](docs/requirements-traceability.md) acompanha todas as secções 0–135.

## Leitura recomendada

1. [Arquitetura e módulos](docs/architecture.md).
2. [Modelo de dados e ERD](docs/database.md).
3. [Isolamento de tenants](docs/multi-tenancy.md) e [segurança](docs/security.md).
4. [API](docs/api.md) e [contrato inicial](packages/api-contracts/openapi/openapi.yaml).
5. [Flutter e experiência do utilizador](docs/flutter-ux.md).
6. [Decisões arquiteturais](docs/decisions/README.md).
7. [Riscos e decisões pendentes](docs/risks-and-decisions.md).
8. [Estado e próximo passo](docs/PROJECT_STATUS.md).

## Stack e execução

NestJS + TypeScript strict, Prisma, PostgreSQL, Redis/BullMQ; Flutter Web, Riverpod e router declarativo. REST/OpenAPI, WebSocket autenticado para inbox. Um monorepo, uma base de código e configuração por empresa.

Pré-requisitos a instalar na Phase 1: Node.js LTS e pnpm com versões fixadas, Docker Compose e Flutter stable com Dart compatível. A matriz exata será registada e verificada no primeiro PR executável; não usar tags `latest` em deploys.

| Operação | Situação e entrega prevista |
|---|---|
| Setup local, backend e workers | Phase 1: scripts versionados e instruções testadas num checkout limpo |
| Flutter Web | Phase 1: shell acessível e execução local documentada |
| Variáveis de ambiente | Catálogo em [integrações](docs/integrations.md); `.env.example` na Phase 1 |
| Migrations e seed | Phase 1/2: Prisma, SQL de segurança e seed demo isolado |
| Testar webhooks e WhatsApp | Phase 4: [desenho e cenários](docs/whatsapp.md) |
| Google Calendar | Phase 7: [OAuth e sincronização](docs/calendar.md) |
| Stripe em test mode | Phase 9: [billing](docs/billing.md) |
| Testes | [Estratégia e gates](docs/testing.md); testes de runtime ainda pendentes |
| Deploy e troubleshooting | [Plano operacional](docs/deployment.md); deploy ainda não configurado |

Não há comando de instalação funcional nesta fase. O próximo PR deve entregar os comandos reais e a evidência da sua execução. Nunca commitar `.env`, credenciais ou dados de clientes.
