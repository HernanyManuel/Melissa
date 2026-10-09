# ADR-082 — Preparação durável de respostas humanas antes da confirmação

## Estado

Aceite como fatia incremental da Phase 8. Workflow funcional [37899957749](https://github.com/HernanyManuel/Melissa/actions/runs/37899957749) verde no commit `49d292258c509886cd8bf6c70df26fb4266eb1bc`, incluindo backend, Compose e Flutter. Sem merge ou deploy.

## Problema

As ADR-078/079/081 garantiram idempotência do POST de resposta manual e consulta read-only da intenção mais recente do ator. Ainda restava uma janela: um POST já destinado ao dispatch podia estar em trânsito quando o Flutter fosse recarregado, antes de guardar no browser a chave idempotente. Um GET vazio não era prova de que esse POST nunca viria a persistir.

## Decisão

- O novo `POST /api/v1/tenants/:tenantId/conversations/:id/manual-replies/prepare` valida o operador (`conversations:reply`), o modo `HUMAN_ACTIVE`, staff, canal WhatsApp live e integridade do texto; grava apenas `human_outbound_intents` com `requestId` e texto sob transação/RLS. Não cria `human_outbound_dispatch`; por isso o worker não pode enviar uma resposta apenas preparada. Um replay idêntico devolve o mesmo `intentId` e `state: prepared`; um replay divergente falha com conflito.
- O endpoint existente `POST /conversations/:id/messages`, chamado depois da preparação, confirma a resposta com os mesmos `requestId`/texto. Quando encontra uma intenção preparada sem dispatch, exige nova verificação do modo/atribuição/canal e igualdade entre o `mode_epoch` atual e aquele gravado na preparação; só depois cria o dispatch na mesma transação e devolve `pending`. Confirmações concorrentes com o mesmo identificador partilham a garantia idempotente da transação tenant-scoped. Se o dispatch já existir, devolve o seu estado sem reenviar.
- Por compatibilidade, clientes legados que chamam diretamente `POST /messages` sem preparar continuam a usar a criação e enqueue transacionais numa operação. **A nova proteção da janela de reload aplica-se ao percurso de dois passos utilizado pelo Flutter, não a todos os clientes legados.**
- O `GET /manual-replies/latest` da ADR-081 reconhece agora a ausência intencional de dispatch e devolve `state: prepared`; antes dessa alteração tratava-a como incoerência. Continua limitado ao próprio ator autenticado dentro do tenant.
- O Flutter prepara antes de confirmar, sem guardar texto sensível em `localStorage`/`sessionStorage`. Um reload recupera uma preparação existente e apresenta confirmação manual, sem POST automático. Se a confirmação HTTP for incerta, volta a consultar o estado e nunca inventa nova chave nem novo texto.

## Verificação

O workflow [37899957749](https://github.com/HernanyManuel/Melissa/actions/runs/37899957749) terminou integralmente verde: migrations e roles PostgreSQL/RLS, formatação/lint/typecheck, unitários/integração, worker/Redis recovery, OpenAPI, Compose, Flutter analyze/test/build web. A integração da resposta humana prova preparação sem dispatch, resposta GET preparada, replay idempotente, divergência 409, confirmação que cria dispatch, e recusa 409 de confirmação após reativação da IA. O widget test prova recuperação de preparação após remontagem sem POST automático e confirmação com chave/texto originais.

## Limites

A proteção depende de usar primeiro o endpoint `prepare`; uma chamada direta do cliente legado a `POST /messages` mantém a semântica anterior. Preparações criadas mas nunca confirmadas permanecem como intenções sem dispatch, e requerem política operacional futura de retenção/expiração/abandono. O GET devolve apenas a intenção mais recente do ator na conversa, não uma listagem completa de rascunhos; operadores devem confirmar que recuperaram a intenção certa. `pending` confirma fila durável e `accepted` aceitação pelo provider — nenhum confirma entrega. Sem validação live com credenciais Meta, merge ou deploy; notificações, unread, notas/tags, painel completo de cliente e E2E continuam pendentes.
