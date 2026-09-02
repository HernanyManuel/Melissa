# Melissa

Plataforma SaaS de operações conversacionais: atendimento, assistente com ferramentas autorizadas e gestão de agenda.

## Estado

Phase 1 em código, **sem execução local ou validação funcional nesta sessão**. Backend e Flutter de infraestrutura criados; auth, tenants e funcionalidades de negócio pertencem às fases seguintes. Production está bloqueada na configuração. Consulte [limites e gates pendentes](docs/phase-1.md).

## Começar

Requisitos: Docker Compose, Node 22/pnpm 10.11.0 para desenvolvimento backend e Flutter 3.35.7 para Web.

```sh
cp .env.example .env
docker compose up --build
```

API: http://localhost:3000/health/ready. Swagger: http://localhost:3000/api/docs. O Compose inclui migrations, PostgreSQL, Redis, API e worker. Flutter:

```sh
cd apps/flutter_app
flutter pub get
flutter gen-l10n
flutter run -d chrome --web-port 8080 --dart-define=API_BASE_URL=http://localhost:3000
```

Os comandos foram escritos mas não executados nesta conversa. [Setup completo, testes e troubleshooting](docs/phase-1.md). Lockfiles serão gerados na primeira resolução e devem ser versionados antes de aceitar a fase.

## Documentação

- [Especificação original](SPECIFICATION.md) e [plano](IMPLEMENTATION_PLAN.md).
- [Arquitetura](docs/architecture.md), [dados](docs/database.md) e [isolamento](docs/multi-tenancy.md).
- [UX Flutter](docs/flutter-ux.md) e [contratos API](docs/api.md).
- [Estado atual](docs/PROJECT_STATUS.md) e [decisões](docs/decisions/README.md).

O contrato OpenAPI de produto é uma proposta; o export gerado pelo backend inclui só os endpoints implementados. Não confundir código de infraestrutura com produto concluído.

## Segurança

Nunca commitar .env ou credenciais; os valores fornecidos são exemplos locais. Não há ligação a Stripe, WhatsApp, OpenAI ou Google nesta fase. Integrações e seeds de empresa serão adicionados com testes e autorização de tenant.
