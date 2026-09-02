# Integrações e credenciais

Nenhuma credencial foi fornecida ou criada nesta fase. Construir abstrações/adapters/mocks e configuração antes de pedir chaves; recolher segredos só no gestor de segredos/ambiente de deploy, nunca no chat ou commit.

| Integração | Configuração necessária | Momento e teste |
|---|---|---|
| PostgreSQL | DATABASE_URL runtime e MIGRATION_DATABASE_URL privilegiada, TLS/roles/backups | P1/P2; instância local descartável primeiro |
| Redis/BullMQ | REDIS_URL, autenticação/TLS e capacidade | P1; filas/locks/rate limit |
| Auth | Chaves de assinatura/rotação, SESSION/CSRF config, APP_URL/API_URL | P2; generated local secrets fora do git |
| OpenAI | OPENAI_API_KEY, projeto, modelos por tarefa e orçamento | P5; mock primeiro, conta de teste para integração |
| WhatsApp | App ID/secret, verify token, WABA ID, phone number ID, access token/ref e API version | P4; Meta test; validar permissões e fluxo self-service antes de live |
| Google Calendar | CLIENT_ID/SECRET, redirect HTTPS/localhost autorizado, scopes e app OAuth | P7; conta teste, tokens por conexão cifrados |
| Stripe | Secret key test/live, webhook secret, product/price/meter IDs, API version | P9; contas e endpoints separados por ambiente |
| Storage S3-compatible | Endpoint, região, bucket, acesso restrito, encryption key/config | P4; storage local compatível ou mock em dev |
| EmailProvider | Provider a escolher, API key/SMTP secret, remetente, domínio verificado | P2; mail sink local; produção exige entrega/validação domínio |
| Sentry | DSN/config de ambiente, sanitização de eventos | P1/P11; opcional local, validado antes de produção |
| Deploy/secrets | Hosting, domínio/DNS, TLS, registry, secret manager, identidades CI | P12; decisão operacional antes de staging |

`.env.example` será criado com variáveis vazias/placeholders seguros junto da configuração validada em P1. Credenciais por tenant são referências no DB, não uma env var global por cliente. Alterar/revogar conexão exige permissão e audit. Provider factory recusa mock em produção; ativação live falha se faltar requisito externo.

Contratos de providers: AIProvider, MessagingProvider, CalendarProvider, BillingProvider, StorageProvider, EmailProvider. Testar cada adapter com suite comum e separar testes determinísticos de smoke tests reais. Provisioning self-service WhatsApp/Google depende das permissões e revisões aplicáveis ao app do provider; a app não pode prometer contornar essas condições.
