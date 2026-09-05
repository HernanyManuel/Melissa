# ADR-047 — Ciclo de ingestão de media sem ativação automática

## Estado

Aceite em 2026-09-05.

## Decisão

O schema 20 estende o envelope mínimo com tentativas, próxima elegibilidade e metadados do objeto armazenado. O payload e o identificador Meta continuam apenas na quarentena cifrada.

O processador recebe somente o UUID interno. Resolve o tenant pelo envelope global, abre contexto RLS, valida o `keyId`, autentica AES-256-GCM com o AAD original e extrai apenas tipo, ID e MIME de media. O `MediaIngestor` aplica novamente allowlist, limites, checksum e chave opaca por tenant.

O armazenamento ocorre antes da conclusão PostgreSQL. Repetições são seguras porque a chave de storage é determinística e `StorageProvider.put` é idempotente. A conclusão e auditoria são serializadas pelo lock do tenant; entregas concorrentes não duplicam a auditoria. Falhas têm até cinco tentativas com backoff limitado e nunca persistem detalhes do provider, URL ou token.

## Limite de ativação

O processador não é iniciado pelo worker nesta decisão. Ainda não existe adapter de storage persistente; o mock em memória não é um destino aceitável para downloads reais. A ativação exige esse adapter, gestão/rotação de chaves e testes de recuperação com processo separado.

## Consequências

- O runtime apenas pode atualizar colunas explícitas do ciclo e sempre sob RLS do tenant.
- A auditoria distingue o worker como ator `system` sem fabricar um utilizador; a constraint continua a exigir utilizador para ações `user` e `NULL` para `whatsapp`/`system`.
- A descoberta global continua a expor apenas metadados operacionais mínimos.
- A retenção da quarentena elimina o envelope por cascade, incluindo resultados já armazenados; a política de eliminação do objeto será definida com o storage persistente.
- Metadados armazenados não são expostos por API ou Flutter neste incremento.
