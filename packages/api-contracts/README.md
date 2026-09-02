# API contracts

- `openapi/openapi.yaml`: proposta de Phase 0, ainda sem implementação de endpoints de produto.
- `generated/infrastructure.openapi.json`: export gerado pelo comando `pnpm openapi`, contendo apenas health endpoints implementados na Phase 1.

O CI publica o export como artifact. Não substituir o contrato de produto pelo health-only export. Antes de gerar cliente Dart de produto, expandir os controllers/DTOs e verificar compatibilidade. A UI de infraestrutura usa HTTP tipado simples para health.
