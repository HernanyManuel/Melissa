# ADR-009 — Sessões e contexto transacional na Phase 2

Estado: implementado em desenvolvimento; release continua bloqueado.

A autenticação usa Argon2id e JWT de curta duração com validação de sessão em PostgreSQL. Refresh tokens opacos são rodados sob lock de sessão e conservados por hash para deteção de replay. Retornar o erro fora da transação é obrigatório para não desfazer a revogação da família. Reset e login usam lock de User para impedir a emissão de uma sessão com a password antiga após reset.

O tenant é validado através da membership do actor; só depois se define o contexto transacional da DB. Criação de tenant usa UUID gerado pelo servidor; aceitação de convite inicia com hash do convite, email verificado e token de uso único. A role runtime não é owner e não tem BYPASSRLS/SUPERUSER. Runtime recebe apenas SELECT/INSERT em auditoria. Migrações têm credencial distinta.

Alterações de memberships e operações empresariais serializam por tenant. Isto simplifica a correção neste volume inicial; medir contenção e reduzir locks em leituras nas fases de escala, preservando a invalidação de permissões em operações críticas.

Desenvolvimento pode gerar chave JWT efémera quando não configurada; não há secret de produção embutido. O frontend Web guarda access em memória e refresh exclusivamente num cookie HttpOnly. Origins e CSRF protegem refresh. Mobile, keyring e coordenação multi-aba são gates explícitos antes de release. Ver detalhes e limitações em `docs/phase-2.md`.
