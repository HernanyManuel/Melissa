# Melissa

Plataforma SaaS de operações conversacionais: atendimento, assistente com ferramentas autorizadas e gestão de agenda.

## Estado

Phase 1 em estabilização: geração Prisma, lint, typecheck, build e quatro testes unitários passaram localmente com Node 22.23.2; auditoria atual sem findings. Backend, integração com worker, Flutter e Compose passaram no [CI de estabilização](https://github.com/HernanyManuel/Melissa/actions/runs/33577099220). Consulte o PR #2 para os checks do commit mais recente. Backend e Flutter de infraestrutura criados; auth, tenants e funcionalidades de negócio pertencem às fases seguintes. Production está bloqueada na configuração. Consulte [limites e gates pendentes](docs/phase-1.md).

## Começar

Requisitos: Docker Compose, Node 22/pnpm 10.11.0 para desenvolvimento backend e Flutter 3.35.7 para Web.

```sh
cp .env.example .env
docker compose up --build
```

API: http://localhost:3000/health/ready. Swagger: http://localhost:3000/api/docs. O Compose inclui migrations, PostgreSQL, Redis, API e worker. Flutter:

```sh
cd apps/flutter_app
flutter pub get --enforce-lockfile
flutter gen-l10n
flutter run -d chrome --web-port 8080 --dart-define=API_BASE_URL=http://localhost:3000
```

O resultado das verificações está em [estabilização](docs/phase-1-stabilization.md). [Setup completo, testes e troubleshooting](docs/phase-1.md). O lockfile pnpm está versionado e é exigido no CI/Docker. O lockfile Flutter foi recuperado da resolução verificada do CI e também é exigido.

## Documentação

- [Especificação original](SPECIFICATION.md) e [plano](IMPLEMENTATION_PLAN.md).
- [Arquitetura](docs/architecture.md), [dados](docs/database.md) e [isolamento](docs/multi-tenancy.md).
- [UX Flutter](docs/flutter-ux.md) e [contratos API](docs/api.md).
- [Estado atual](docs/PROJECT_STATUS.md) e [decisões](docs/decisions/README.md).

O contrato OpenAPI de produto é uma proposta; o export gerado pelo backend inclui só os endpoints implementados. Não confundir código de infraestrutura com produto concluído.

## Segurança

Nunca commitar .env ou credenciais; os valores fornecidos são exemplos locais. Não há ligação a Stripe, WhatsApp, OpenAI ou Google nesta fase. Integrações e seeds de empresa serão adicionados com testes e autorização de tenant.
