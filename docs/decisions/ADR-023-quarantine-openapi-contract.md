# ADR-023 — Contrato OpenAPI de quarentena

Estado: incremento de integração da Phase 4.

## Decisão

Formalizar a resposta existente de GET `/api/v1/tenants/{tenantId}/quarantine` com DTOs e operationId estável `listQuarantineMetadata`. Sem mudar o formato HTTP existente.

O contrato declara bearer auth, UUIDs, cursor opcional, página de até 50 itens, cursor final nulo, datas RFC 3339, contadores inteiros, capacidade e enum de avisos. Define Cache-Control no-store e X-Request-Id, além de respostas sanitizadas 400/401/403/404/500. O seletor tenant continua sujeito a membership/RBAC/RLS; OpenAPI não substitui autorização nem validação runtime.

Sem conteúdo, ciphertext, nonce, tag, chave, hash ou destinatário no esquema de metadados. Os testes validam a lista exata de propriedades publicada, propriedades obrigatórias, paginação e formatos. A integração HTTP verifica cabeçalhos e recusa parâmetros extra, incluindo tentativa de alterar o limite de página.

## Geração e limites

`pnpm openapi` gera o documento a partir da aplicação; a CI disponibiliza-o no artefacto backend-bootstrap-artifacts. Não manter uma segunda cópia manual do JSON. Este incremento cobre o endpoint de quarentena, não afirma cobertura completa dos contratos das restantes APIs nem geração do cliente Dart. Sem migration, alteração de UI, ativação real, merge ou deploy.
