# ADR-057 — Contexto mínimo e dados não confiáveis para IA

## Estado

Aceite para o incremento atual da Phase 5.

## Decisão

`AIContextBuilder` produz o pedido neutral do provider a partir de um snapshot tenant-scoped. A política de sistema é estática e mantida separada dos dados configuráveis. Perfil, preferências, políticas, FAQs, serviços e dados mínimos do cliente são serializados num bloco `REFERENCE_DATA_JSON`, explicitamente marcado como dados não confiáveis e nunca como instruções.

`PrismaAIContextSource` verifica tenant, conversation e customer na mesma query sob RLS. O snapshot exclui telefone, email, notas, consentimentos, credenciais, metadata de canal, configuração operacional e IDs que não sejam necessários às tools. Apenas as 12 mensagens de texto mais recentes são incluídas, em ordem cronológica.

Campos extensos são truncados e o bloco de referência tem orçamento máximo aproximado de 24 mil caracteres. Mensagens históricas são limitadas a 2500 caracteres cada. Quando necessário, FAQs e serviços são removidos deterministicamente do fim até caber no orçamento. Dados canónicos continuam acessíveis apenas através de tools read-only.

Em modo `live`, o builder recusa conversas que não estejam `AI_ACTIVE`. O sandbox pode construir contexto de uma conversa pausada, mas continua isolado e não implica ativação.

## Consequências e limites

- Conteúdo configurado pelo tenant não altera diretamente a política de sistema.
- Delimitação reduz risco, mas não elimina prompt injection; autorização de tools, validação e confirmação determinística continuam obrigatórias.
- O snapshot não é fonte de verdade para disponibilidade ou ações críticas.
- Ainda não existe resumo persistente, state version, metering, loop de tool calling ou ligação ao worker.
- O caminho completo terá de revalidar `mode_epoch` antes de persistir/enviar qualquer resposta.
