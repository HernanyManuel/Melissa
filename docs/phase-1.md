# Phase 1 — infraestrutura em código

> Registo da entrega inicial. Para o estado atualizado, consultar [estabilização](phase-1-stabilization.md) e [PROJECT_STATUS](PROJECT_STATUS.md); as limitações de execução abaixo descrevem a sessão original.

Estado: código preparado sem execução local, a pedido explícito do utilizador. Não classificar a fase como validada até CI/ambiente executar os gates. Base: Phase 0 e correções do contrato no commit db83f89a79c47c9f68ca365aac3280b5436b7b89.

## Entregue

- Monorepo pnpm, TypeScript strict, ESLint e comandos de formatação.
- NestJS API com /health, /health/live, /health/ready; Swagger em /api/docs.
- Prisma client, schema/migration de bootstrap e readiness que verifica versão da migration.
- Redis e worker BullMQ separado; fila infrastructure aceita exclusivamente ping.
- Logs JSON sanitizados por allowlist, request ID gerado no servidor, error envelope, Helmet/CORS.
- Compose de desenvolvimento com PostgreSQL/Redis/API/worker/migration; runtime de container sem root.
- Flutter Web + Riverpod + router, tema Material 3, navegação adaptável, seis ARBs e estado real de ligação.
- Testes unitários de config, integração com DB/Redis/worker e widget tests.
- CI de lint/typecheck/test/build, integration, Docker Compose, OpenAPI export e audit.
- Código de shutdown e resource cleanup; production bloqueada antes de existir segurança de produto.

Não implementa auth, tenants, memberships, RLS, APIs de negócio, credenciais externas ou dados de clientes. Estes não são simulados por endpoints que retornam sucesso. A base PostgreSQL contém apenas metadata de infraestrutura. Seed de empresa pertence a P2/P3; não criar utilizador administrador com password fixa.

## Versões e dependências

Baseline explícita, não declaração de versões mais recentes: Node 22, pnpm 10.11.0, Nest 11.1.6, Prisma 6.19.0, Flutter 3.35.7. As versões diretas dos packages estão fixadas. Prisma 6 foi escolhido para o bootstrap com client generator e configuração no schema; upgrades de major exigem testes. Referências: [Prisma 6.19](https://www.prisma.io/blog/announcing-prisma-6-19-0), [arquivo Flutter](https://docs.flutter.dev/install/archive).

Sem runtime não foram resolvidas dependências transitivas. Por isso pnpm-lock.yaml e pubspec.lock **não foram inventados**. O CI resolve e publica ambos como artifacts. Antes de aceitar a fase: obter os lockfiles da primeira resolução verificada, commitar, alterar install para frozen/enforce-lockfile e fixar imagens/actions por digest/SHA. Docker tags atuais fixam major/minor, não conteúdo imutável.

O audit pode encontrar vulnerabilidades nesta baseline; devem ser corrigidas antes de merge/release. Configurar formatter, executar pnpm format e dart format e depois verificar diffs. Formatting não é ainda gate do CI porque não foi possível produzir a saída dos formatters nesta sessão.

## Instalação prevista (a verificar)

Na raiz: copiar .env.example para .env. As credenciais de exemplo são exclusivamente locais, sem valor de produção. URL-encode caracteres especiais em passwords quando usados em DATABASE_URL; exemplo fornecido já usa caracteres seguros.

Docker:
```sh
cp .env.example .env
docker compose up --build
```

O job migrate aplica a migration antes de API/worker iniciarem. Serviços de dados e API publicados apenas em loopback; worker não é exposto ao host. Flutter roda separadamente na porta 8080.

Backend no host:
```sh
npm install -g pnpm@10.11.0
pnpm install --no-frozen-lockfile
docker compose up -d postgres redis
set -a
. ./.env
set +a
pnpm db:generate
pnpm db:migrate
pnpm build
pnpm dev
```

Noutro terminal, exportar o mesmo .env e executar pnpm worker. O CLI Prisma é executado no package backend: o export de ambiente é necessário para os comandos locais. Não copiar secrets para o Flutter.

Flutter:
```sh
cd apps/flutter_app
flutter pub get
flutter gen-l10n
flutter run -d chrome --web-port 8080 --dart-define=API_BASE_URL=http://localhost:3000
```

O frontend não tem sessão de utilizador ainda. O ecrã inicial não mostra métricas inventadas nem configurações de empresa fictícias. O botão de ligação consulta a readiness real da API; erro oferece retry.

## Testes previstos

```sh
pnpm lint
pnpm typecheck
pnpm test
# Com PostgreSQL, migration, Redis e worker já ativos:
pnpm test:integration
pnpm openapi
pnpm audit --audit-level high
```

Dentro de apps/flutter_app: flutter analyze, flutter test, flutter build web. Artefacto OpenAPI gerado descreve apenas a API implementada. Contrato de produto da Phase 0 permanece separado.

## Limites operacionais

- Dockerfile é baseline de desenvolvimento: inclui toolchain e dev dependencies para facilitar bootstrap. Imagem slim multi-stage de produção, SBOM, hardening e secrets manager pertencem aos gates seguintes.
- Readiness da API verifica DB/schema e Redis; não garante disponibilidade de integrações futuras. Worker abre health server só após conexão do consumidor; round-trip test comprova consumo quando executado.
- Runtime de DB usa user local de desenvolvimento. Roles de migration/runtime separadas e RLS são gate P2 antes de introduzir dados empresariais.
- NODE_ENV=production é recusado explicitamente. Não existe deploy automático.
- Nenhum secret, serviço pago ou conta externa foi criado.
- Sem lockfiles/execução, instalação e compatibilidade continuam por comprovar; CI codificado não é sinónimo de CI aprovado.

## Critérios restantes de aceitação

- [ ] Resolver e versionar lockfiles após build verde.
- [ ] Executar lint/typecheck/unit/integration/Flutter/Compose e corrigir resultados.
- [ ] Executar formatters e transformar verificação de formato em gate.
- [ ] Rever audit e versões transitivas.
- [ ] Testar UI em browser/teclado e seis idiomas.
- [ ] Fixar toolchain/imagens/actions imutavelmente para release.
- [ ] Rever e fazer merge dos PRs por ordem.
