# ADR-084 — Expurgo de texto em preparações humanas abandonadas e expiradas

## Estado

Aceite como fatia incremental da Phase 8, ainda sem merge/deploy. Validado no commit funcional `80b933132ca38efa2f87b3100b961026dbce2754` pelo workflow [37942049114](https://github.com/HernanyManuel/Melissa/actions/runs/37942049114), com backend, Flutter e Compose verdes.

## Contexto

A ADR-082 introduziu a separação entre preparação durável sem dispatch e confirmação com criação de dispatch. A ADR-083 estabeleceu validade de 24 horas e abandono explícito, mas manteve `content_text` de intenções abandonadas ou expiradas indefinidamente, embora estas já não pudessem ser enviadas.

É necessário reduzir a retenção de dados de clientes sem apagar a evidência de idempotência (`request_id`, ator, tenant, conversa, epoch), sem alterar `human_outbound_dispatch` e sem criar um caminho para reenvio.

## Decisão

- A migração **58** acrescenta `human_outbound_intents.redacted_at`. Uma preparação expurgada mantém a linha, substitui `content_text` por uma marca fixa `[redacted]` e preenche `redacted_at`; não guarda hash reversível ou outro derivado do texto. A chave idempotente e os metadados permanecem. A migração expurga preparações **sem dispatch** já abandonadas ou expiradas à data da migração.
- O `POST /manual-replies/abandon` passa a gravar `abandoned_at`, `redacted_at` e a marca de expurgo **na mesma transação**. O serviço faz `SELECT ... FOR UPDATE` na intenção existente, tal como os caminhos de confirmação, para impedir a corrida entre confirmação e expurgo.
- O `GET /manual-replies/latest` continua a devolver `state: abandoned|expired`, mas devolve **`text: null`** quando `redacted_at` está preenchido. O Flutter aceita texto nulo apenas nestes estados terminais, não mostra o texto no ecrã e não permite confirmação. O botão de nova resposta continua a exigir ação explícita.
- Replays `POST /manual-replies/prepare` e `POST /messages` cujo texto tenha sido expurgado deixam de conseguir demonstrar igualdade com o texto inicial e, normalmente, respondem 409; não recriam o conteúdo nem um dispatch. A única eventual coincidência literal com a marca fixa não altera a proibição de confirmação de uma intenção abandonada/expirada.
- A BD limita o UPDATE do texto e do timestamp de expurgo à role runtime e instala uma trigger para **recusar alterações de conteúdo arbitrárias, reversão de expurgo, abandono sem expurgo e expurgo de intenções já com dispatch**. O health check exige `schema_version=58`.
- Para expiração posterior à migração, `redactExpiredPreparations` opera apenas sobre intenções com mais de 24 horas ou abandonadas **sem dispatch**, com `FOR UPDATE SKIP LOCKED`, verificações de ausência de dispatch antes e durante o UPDATE e lotes limitados a 500. É chamado por uma ferramenta administrativa manual com credenciais privilegiadas. Nenhum worker ou scheduler de produção é ativado nesta fatia.

## Procedimento operacional

Executar **apenas** num contexto operacional controlado com `MIGRATION_DATABASE_URL` definido para o ambiente correto. Não registar o URL, credenciais ou textos em logs.

1. Simular e obter apenas a contagem de preparações elegíveis, sem qualquer alteração:

   ```sh
   pnpm --filter @melissa/backend privacy:redact-manual-preparations
   ```

2. Depois de verificar o ambiente, aplicar um lote (até 500):

   ```sh
   pnpm --filter @melissa/backend privacy:redact-manual-preparations --apply
   ```

3. Confirmar a contagem remanescente com o primeiro comando e repetir apenas sob controlo operacional. O comando imprime **contagens**, nunca mensagens nem IDs. A ausência de `--apply` significa modo de simulação. Não é um cron job automático.

## Verificação

No workflow [37942049114](https://github.com/HernanyManuel/Melissa/actions/runs/37942049114), a migração 58, o schema Prisma, formatação/lint/typecheck, backend com PostgreSQL/RLS e worker, Flutter analyze/test/build web e Compose passaram. Testes HTTP/BD validam expurgo imediato no abandono, `GET` devolvendo `text:null`, expurgo em lote após expiração e exclusão de intenções já despachadas, inclusive antigas. A trigger rejeita tentativa explícita de expurgar uma intenção com dispatch; Flutter testa recuperação de tombstone redigido sem texto nem envio.

## Limites e riscos assumidos

- Trata-se de **expurgo do texto da linha ativa** em PostgreSQL, não de apagamento forense. Versões MVCC, WAL, backups, réplicas, observabilidade, mensagens efetivamente enviadas ou sistemas externos podem conservar cópias até serem eliminadas segundo a respetiva política. Não afirmar eliminação irreversível de dados pessoais.
- Preparações que expiram **depois** da migração continuam com texto até ao comando operacional; a validade de 24 horas impede confirmação, mas **não garante expurgo automático às 24 horas**. É preciso definir frequência operacional, requisitos legais de retenção e política de backups antes de produção.
- Mensagens com dispatch `pending/accepted/rejected/failed` ficam fora deste expurgo para preservar reconciliação do provider. Esta ADR não define a retenção de mensagens enviadas nem de histórico de conversas.
- Operações com clientes legados que chamam `POST /messages` diretamente não passam pela preparação. O GET cobre só a última intenção do ator. Sem credenciais Meta reais, não há validação E2E live nem autorização para merge/deploy.
