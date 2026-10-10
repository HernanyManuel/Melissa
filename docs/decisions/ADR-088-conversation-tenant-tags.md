# ADR-088 — Etiquetas de conversas com isolamento por tenant

## Estado

Fatia incremental da Phase 8 em PR draft, sem merge nem deploy.

## Problema

As notas privadas (ADR-087) suportam contexto textual imutável, mas não existe ainda classificação estruturada de conversas por etiquetas. As etiquetas devem ser metadados internos; não podem alimentar a fila de mensagens nem a entrega ao cliente.

## Decisão

- Migração **61**: `conversation_tags` contém o catálogo por tenant (`name` de 1 a 40 caracteres após trim, com unicidade por tenant). `conversation_tag_links` associa conversa/etiqueta e conserva o ator que fez a associação. Chaves estrangeiras compostas impedem cruzar tenants; RLS é obrigatória e a role runtime só tem permissões estritamente necessárias.
- As etiquetas criadas são imutáveis nesta fatia: sem rename ou DELETE do catálogo. As ligações podem ser adicionadas e removidas, de forma idempotente, por utilizadores com `conversations:takeover`. A visualização requer `messages:read` e a validação de que a conversa pertence ao tenant.
- `GET /conversations/:id/tags` retorna `available` (até 100 etiquetas) e `applied` (IDs associados); `POST /conversation-tags` cria a etiqueta ou devolve a mesma caso o nome já exista; `POST /conversations/:id/tags/:tagId` associa e `DELETE` remove, preservando semântica idempotente. As mudanças geram auditoria com IDs e sem textos de mensagens.
- O Flutter apresenta as etiquetas num painel próprio aberto pelo ícone no cabeçalho da conversa, sem aumentar a altura do histórico. O painel suporta criação e seleção de etiquetas, em pt/en/es/fr/it/de. A interface não chama `/messages` e não cria intents nem dispatches.
- A migração exige `schema_version=61` no health check. Testes de integração cobrem acesso entre tenants, nomes inválidos, criação repetida, associação, remoção e auditoria.

## Limites

O catálogo é limitado a 100 etiquetas por resposta nesta fatia; não existe paginação de catálogo, bulk tagging, filtro por etiqueta no inbox nem gestão avançada de permissões por etiqueta. Associações podem ser alteradas por operadores autorizados, mas o histórico é preservado em `audit_events` sem conter texto do cliente. Ainda não existe política própria de retenção para essas linhas de metadados. Não existem alterações de canal live, credenciais externas, merge ou deploy.
