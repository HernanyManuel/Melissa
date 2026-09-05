# Melissa

Plataforma SaaS de operações conversacionais: atendimento, assistente com ferramentas autorizadas e gestão de agenda.

## Estado

Phase 3: onboarding e configuração empresarial sobre contas, sessões revogáveis e isolamento PostgreSQL. Perfil, serviços, horários, exceções, equipa, FAQs, políticas e personalidade têm API/DB; Flutter inclui wizard em seis idiomas. Produção continua bloqueada. Ver [Phase 3](docs/phase-3.md).

## Começar

Requisitos: Docker Compose, Node 22/pnpm 11.25.0 para desenvolvimento backend e Flutter 3.35.7 para Web.

```sh
cp .env.example .env
docker compose up --build
```

API: http://localhost:3000/health/ready. Swagger: http://localhost:3000/api/docs. O Compose inclui migrations, PostgreSQL, Redis, API, worker e Mailpit. Emails locais: http://localhost:8025. Para volumes existentes da Phase 1, seguir a migração de role em [Phase 2](docs/phase-2.md) antes de iniciar. Flutter:

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
