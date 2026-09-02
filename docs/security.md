# Segurança e privacidade

Modelo de ameaça: atacante externo, utilizador de tenant malicioso, prompt injection, webhook falso/repetido, sessão roubada, suporte abusivo e integração comprometida. Fronteiras: navegador/API, API/DB, ingress/worker, LLM/tools e providers externos.

## Identidade e sessões

Decisão P0: auth no backend com email/password, verificação de email, hashing Argon2id e reset de uso único com token aleatório armazenado como hash, expiração e respostas sem enumeração. Parâmetros do hash serão benchmarkados na P2. Social login é extensão, não condição de entrega.

Access JWT curto (proposta: 10 min), issuer/audience/algorithm fixos e assinatura com rotação de chave. Refresh opaco aleatório (não JWT obrigatório), hash persistido, rotação a cada utilização e revogação da família em replay; duração máxima proposta 30 dias. O frontend serializa refresh para evitar corridas. Browser: refresh HttpOnly/Secure/SameSite, access em memória; API e app preferencialmente same-site. Logout revoga sessão, fecha socket e limpa caches. Mobile futuro usa storage seguro da plataforma.

Endpoints autenticados por cookie exigem verificação de Origin e proteção CSRF explícita; CORS allowlist exata. Nunca guardar refresh token em localStorage. Reautenticação para billing sensível, transferência/exclusão tenant e impersonation. MFA de administradores é gate de produção proposto. Aceitação de termos e privacidade regista versão, instante e origem.

## Controlo de dados

DTO allowlist, limites de tamanho, sem mass assignment, SQL parametrizado e sem SQL no controller. Respostas omitem tokens, secrets, hashes e notas internas fora do âmbito autorizado. Erros têm código e request_id, sem stack. Logs JSON com redaction de Authorization, cookies, tokens OAuth, credenciais e conteúdo pessoal desnecessário. Audit não guarda cópias de secrets em before/after.

Storage privado com prefixo tenant, metadados de ownership, URLs curtas assinadas e autorização prévia. Validar tamanho/MIME real, quarentena de anexos e scan antes de disponibilizar. URLs fornecidas pelo cliente não podem provocar SSRF: restringir destino, redirects e endereços privados quando houver fetch remoto.

## Segredos e providers

.env só local; secret manager em produção; DB armazena referências. Refresh OAuth cifrado por envelope com versão de chave; chave fora da DB. Rotação testada. Nunca enviar config de billing ou credenciais para IA ou Flutter. Adapters verificam timeouts e sanitizam erros.

WhatsApp/Stripe: assinatura do corpo bruto, comparação segura e deduplicação persistente. Google Calendar: validar channel token, channel/resource IDs e validade; não inventar assinatura HMAC inexistente (ADR-005). Requests de integração não determinam tenant a partir de input arbitrário.

## LLM e controlo de custos

Conteúdo do cliente e documentos são dados não confiáveis. Registry e permissões definidas no servidor. Executor valida tenant, customer da conversa, membership se humano, plano, schema, estado e idempotency key de ação. Modelo não escolhe ambiente, tenant ou autorização. Tool outputs mínimos; limites de chamadas, tokens, tempo e orçamento. Nenhum prompt constitui barreira de segurança suficiente.

## Retenção e recuperação

Soft delete não cumpre por si só apagamento de dados. Export assíncrono autorizado, URL privada e expiração; hard delete/anonymization em job auditado respeita categorias de dados, obrigações contratuais e retenções aplicáveis. Consentimento de marketing separado de termos de serviço; alterações com histórico. Política por tenant, mínimos/máximos definidos pela plataforma e processo de retenção de backups com expiração documentada.

Termos, política de privacidade, prazos legais e transferências internacionais requerem revisão própria antes do lançamento; este documento é desenho técnico, não certificação de conformidade. Não fixar prazos legais sem decisão documentada.

## Gates de produção

HTTPS/HSTS, headers/CSP compatíveis com Flutter, CORS, rate limits por IP/actor/tenant com limites no proxy, dependências e secrets scanning, backup cifrado, restauro ensaiado, isolamento negativo comprovado, permissão mínima e runbook de incidente. Limitar ingress antes de payload parsing; webhook não deve perder durabilidade por erro na fila após commit.
