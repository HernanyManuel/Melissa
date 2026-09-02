# Phase 2 — Identidade e empresas

Entrega no PR #3, sobre a branch da Phase 1. A especificação original permanece intacta. O código desta fase permite registar/verificar uma conta, autenticar, criar/listar/selecionar empresas, convidar membros, alterar roles/estado por API e revogar sessões. O Flutter Web inclui conta, recuperação, convite, lista/criação de empresas e estado ativo da equipa em seis idiomas.

## Execução local

Para uma base nova: copiar `.env.example` para `.env` e executar `docker compose up --build`. PostgreSQL cria `melissa_runtime` sem SUPERUSER/BYPASSRLS/ownership; o container `migrate` usa o owner e a aplicação usa runtime. Não colocar a URL de migration no ambiente da API.

Para um volume existente da Phase 1, provisionar a role antes de aplicar esta migration, preservando os dados:

```sh
# Carregar apenas o ficheiro .env local que controlas.
set -a
. ./.env
set +a
psql "${MIGRATION_DATABASE_URL%%\?*}" -v ON_ERROR_STOP=1 \
  -v runtime_password="$RUNTIME_PASSWORD" -f infra/scripts/runtime-role.sql
DATABASE_URL="$MIGRATION_DATABASE_URL" pnpm db:migrate
```

Atualizar `.env` com `RUNTIME_PASSWORD` e a nova `DATABASE_URL` de runtime. Não apagar volumes para corrigir configuração. Depois iniciar API/worker com a URL runtime. Readiness recusa owner/SUPERUSER/BYPASSRLS e exige schema_version=2. A função de migração pode precisar de privilégios de administrador para provisionar a role; o runtime nunca os recebe.

Flutter: `flutter run -d chrome --web-port 8080 --dart-define=API_BASE_URL=http://localhost:3000`. Abrir **Conta**. Criar conta, aceitar os termos de desenvolvimento e confirmar email no Mailpit em `http://localhost:8025`. Mailpit captura mensagens localmente; não entrega a destinatários externos. Abrir a ligação e confirmar, depois entrar e criar a empresa. Convites exigem login com o mesmo email verificado.

## Contrato implementado

Swagger em `/api/docs` e export pelo comando `pnpm openapi`. O YAML em `packages/api-contracts/openapi` continua a ser o contrato alvo de todo o produto; o JSON gerado contém as rotas efetivamente implementadas. Nomes concretos de DTOs/fields nesta fase: `name`, `countryCode`, `timezone`, `termsAccepted`; a tradução para o contrato alvo será versionada antes de clientes externos.

Auth: register, login, logout, refresh, csrf, me, verify, resend-verification, forgot-password, reset-password. Registo exige `termsAccepted: true`; versão e instante ficam na DB. Termos são exclusivamente de desenvolvimento, explícitos na interface. Textos comerciais/privacidade são gate de release.

Tenants: GET/POST `/api/v1/tenants`, GET/PATCH `/:id`, GET/PATCH memberships, POST invitations, POST invitations/accept, GET audit. IDs em rotas são UUIDs. Headers de tenant divergentes são rejeitados. Nunca atribuir privilégios de plataforma por estas rotas. Listagens limitadas a 100; paginação completa é trabalho registado antes da escala de produção.

## Garantias e decisões

- Argon2id, memória 64 MiB, três passes, paralelismo 1. Benchmark em hardware de produção e rehash progressivo ficam no gate P11.
- JWT HS256, issuer/audience fixos, 10 minutos; todas as chamadas autenticadas consultam a sessão na DB. Secret configurável com pelo menos 48 caracteres. Em desenvolvimento sem secret, cada processo gera uma chave efémera: reiniciar a API invalida access tokens. Refresh persistido permite recuperação. Deploy multi-instância exige secret partilhado/rotação antes de ser ativado.
- Refresh opaco de 256 bits guardado apenas por SHA-256, cookie HttpOnly/SameSite=Strict, Secure em HTTPS. Família com validade absoluta de 30 dias. A rotação serializa a sessão; replay revoga toda a família e confirma a transação antes de responder 401.
- Flutter guarda access token em memória; o browser gere o cookie. Refresh concorrente numa instância é serializado. Duas abas que rodem simultaneamente o mesmo refresh podem revogar a família; nesse caso é necessário novo login. Coordenação entre abas é melhoria explícita antes de release, sem relaxar a deteção de replay.
- Origin e CSRF HMAC são exigidos na rotação. Requests same-origin identificados pelo browser são aceites no bootstrap CSRF. Produção exige proxy configurado, HTTPS e domínio same-site.
- Roles e memberships são consultadas em cada transação. Lock de tenant serializa alterações de permissões e operações desse tenant. SQL parametrizado, contexto transacional e RLS ENABLE/FORCE. Sem contexto, nenhuma linha empresarial é visível. As tabelas de identidade global são privadas ao backend.
- Owner não pode ser desativado, promovido ou despromovido pela edição genérica. Admin não altera admins/owner nem convida owner/admin. Transferência de ownership e exclusão de empresa aguardam fluxo específico de reautenticação; nenhuma rota insegura é oferecida.
- Auditoria de criação/alteração de empresas, memberships e convites; runtime não tem UPDATE/DELETE em audit. Campos não incluem passwords/tokens.
- Rate limits Redis para autenticação, por IP e hash de email, incrementos atómicos e janela de 15 minutos. Falha de Redis não autoriza bypass. Proxy trust não é ativado indiscriminadamente.
- Verificação/reset/convites têm hash, prazo e uso único. Password reset revoga sessões e restantes tokens de reset; convites não substituem memberships existentes.

## Validação

`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` com PostgreSQL/Redis e worker real. CI valida explicitamente a role runtime e RLS, recusa cross-tenant, alterações do último owner, convites com email errado/reutilizados, revogação de memberships, CSRF, refresh replay e reset/logout. Flutter testa serialização de refresh, logout falhado/sucesso e formulário com consentimento além dos testes da infraestrutura.

Docker Compose e Flutter passaram na primeira execução do PR; o primeiro job backend detetou uma incompatibilidade de parâmetros Prisma na chamada psql de bootstrap, corrigida no follow-up. Consultar os checks do commit atual no PR #3 para o resultado final.

## Limites preservados

Produção continua desativada. P3 acrescenta onboarding e configuração de negócio. Native mobile com armazenamento seguro, coordenação entre abas, rotação de chaves com keyring, MFA, termos comerciais, apagamento/exportação, ownership transfer e hardening operacional permanecem nos gates documentados, não são declarados prontos. O adaptador SMTP atual destina-se apenas a Mailpit; SMTP autenticado/TLS, templates de email localizados e outbox com retry durável exigem implementação antes de emails reais em produção. Falha local de envio pode ser recuperada por reenviar verificação/recuperação/convite; não se regista sucesso de envio falso.

As FKs atuais ligam entidades empresariais diretamente a Tenant e identidade global. `UNIQUE(tenantId,id)` prepara entidades-filho; FKs compostas entre dois parents empresariais serão adicionadas/testadas com serviços/staff/bookings. Não se afirma que os testes atuais cobrem domínios que ainda não existem.
