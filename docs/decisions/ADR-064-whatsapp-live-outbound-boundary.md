# ADR-064 — Fronteira live de outbound WhatsApp e outcome ambíguo

- Estado: aceite
- Data: 2026-09-10

## Contexto

O dispatcher automático já aplica fencing por `AI_ACTIVE` e `mode_epoch`, mas um envio WhatsApp live precisa ainda de identidade de remetente e credencial específicas da `ChannelConnection`. A base de dados guarda `external_phone_id` e `credentials_reference`; a fila não deve transportar nenhum destes valores e a referência de credencial nunca deve ser tratada como segredo bruto.

Existe também uma diferença importante entre idempotência interna e efeito externo. O intent possui um `attemptId` estável, mas este incremento não assume que a API externa de messaging deduplica uma repetição após timeout, erro HTTP ou recibo malformado. Fazer retry automático nessas situações pode duplicar uma mensagem já aceite pelo provider.

## Decisão

`PrismaAIAutomaticOutboundStore` carrega `external_phone_id` e `credentials_reference` diretamente da `ChannelConnection` dentro do contexto RLS do tenant. Para WhatsApp live, ambos são obrigatórios. O segundo fence imediatamente anterior ao efeito externo volta a exigir que esses valores ainda coincidam com os do claim, além das verificações de modo, epoch, estado da conversa, customer e channel.

`OutboundText` pode transportar `senderReference` e `credentialsReference` entre componentes server-side. Estes campos não são aceites da fila nem do frontend. `credentialsReference` é uma referência opaca; o token real só pode ser obtido através da interface `SecretResolver` dentro do adapter live.

`WhatsAppCloudMessagingProvider` implementa `MessagingProvider` com chave `whatsapp:live`. A construção do adapter não faz rede nem resolve secrets. No envio, ele:

1. valida remetente, destinatário, texto e referência de credencial;
2. resolve a credencial através de `SecretResolver`;
3. chama apenas o endpoint HTTPS fixo do Graph para o `senderReference` validado;
4. bloqueia redirects, aplica timeout e limita a resposta;
5. só devolve sucesso quando recebe um `providerMessageId` válido.

A ausência de routing, secret ou provider continua a falhar fechada; nunca existe fallback live → mock.

Se a falha ocorrer depois de a chamada live poder ter sido iniciada, o adapter lança `MessagingDeliveryUnknown`. O dispatcher trata esse outcome como terminal: `ai_outbound_dispatch` passa para `failed`, incrementa a tentativa e regista `ai.outbound_delivery_unknown`. Não há retry automático desse envelope. Falhas anteriores ao efeito externo continuam sujeitas à política normal de retry.

`startAIAutomaticOutboundRuntime` compõe provider, registry, dispatcher e queue numa única fronteira. A função exige um `SecretResolver` explícito antes de iniciar consumo e recebe a versão Graph e Redis server-side. O queue starter é injetável apenas para teste; no runtime normal usa `startAIAutomaticOutboundQueue`.

## Consequências

- A identidade de remetente e a referência de credencial são resolvidas da fonte de verdade e voltam a ser verificadas imediatamente antes do envio.
- Fila e frontend continuam sem tenant, token, sender ID, destinatário ou texto do outbound automático.
- Segredos brutos não são persistidos no intent/dispatch e não fazem parte do contrato de queue.
- Um timeout ou resposta externa ambígua privilegia prevenção de duplicados sobre retry automático.
- O adapter live é testável com `SecretResolver` e `fetch` injetáveis, sem credenciais reais nem chamadas reais nos testes.
- A composição falha antes de iniciar queue se a versão do provider for inválida e não inventa um secret backend.
- Este ADR não ativa envio live: não existe ainda implementação production-grade de `SecretResolver` no bootstrap, e `worker.ts` não chama `startAIAutomaticOutboundRuntime`.
- A ativação futura deve validar todas as dependências antes de iniciar consumo; configuração incompleta não pode consumir retries de intents pendentes.
