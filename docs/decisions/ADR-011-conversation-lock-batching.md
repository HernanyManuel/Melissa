# ADR-011 — Lock renovável e batching inbound

Estado: implementado para entrada mock; validação integral nos checks do PR #5.

## Decisão

Agrupar eventos por tenant, canal e cliente em `inbound_batches`, com RLS forçada e referências compostas. `MESSAGE_DEBOUNCE_MS` aceita 100–2000 ms (default 1500). Cada evento novo prolonga a janela de silêncio, nunca além de cinco segundos desde a criação do lote. Máximo de 50 eventos por lote. Duplicados não prolongam a janela. Os envelopes duráveis só ficam elegíveis após o prazo; tentativas com backoff não são antecipadas.

O worker adquire um lease Redis por identidade tenant/canal/cliente, mesmo antes de existir uma conversa. SET NX PX usa um token aleatório; scripts Lua renovam e libertam apenas se o token ainda corresponde. TTL de 15 segundos, renovação a cada cinco segundos, sem renovações concorrentes. Contenção deixa o envelope pendente, sem gastar tentativas. Perda do lease aborta a transação e segue o retry existente.

O primeiro processamento fecha o lote (`sealedAt`), impedindo novas adesões. Mensagens continuam individuais, com `batchId` partilhado. Lotes e prazos sobrevivem ao reinício do processo; mensagens históricas podem ter batchId nulo.

## Garantias e limites

Redis não é a única proteção de integridade: permanecem transações PostgreSQL, lock conservador do tenant, dedupe e restrições únicas. A verificação do token imediatamente antes de terminar a transação não é um fencing token para sistemas externos. Não há chamadas externas nesta região crítica.

`sealedAt` significa fechado a novas entradas, NÃO processamento completo. Um futuro consumidor IA terá de verificar todos os envelopes do lote, definir a política para rejected/failed e persistir a sua própria execução idempotente. Esta entrega não produz respostas agrupadas nem chama IA.

A serialização SQL por tenant permanece um limite de escala. Failover real de Redis, crash forçado e stress de múltiplos workers não foram validados por estes testes. Não ativar WhatsApp/outbound com base apenas neste mecanismo.

## Verificação

Testes unitários do prazo e configuração; integração Redis de exclusão, renovação além do TTL e proteção do token sucessor; integração PostgreSQL/worker de lote partilhado, separação por canal, prazo limitado e fecho. Aplicar migration 8 antes de iniciar API/worker.
