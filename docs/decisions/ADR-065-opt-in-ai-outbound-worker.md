# ADR-065 — Worker de outbound IA opt-in com secrets montados

- Estado: aceite
- Data: 2026-09-10

## Contexto

A fronteira live definida no ADR-064 já separa `credentials_reference` do segredo bruto e compõe provider, dispatcher e queue através de `startAIAutomaticOutboundRuntime`. Faltava uma implementação server-side de `SecretResolver` e um caminho de bootstrap que pudesse ativar o consumer sem colocar tokens na base de dados, na fila ou em variáveis globais por tenant.

Adicionar um SDK específico de AWS/GCP nesta fase aumentaria dependências e acoplamento sem existir ainda uma decisão de infraestrutura para um secret manager concreto. O runtime precisa, porém, de uma opção utilizável em containers e Kubernetes que preserve referências opacas por canal.

## Decisão

O primeiro backend de secrets é `MountedFileSecretResolver`. Ele aceita apenas referências no formato `secret://segment[/segment...]`, com segmentos limitados e sem `.`/`..`. A configuração fornece uma única diretoria absoluta server-side; a root e cada alvo são canonicalizados com `realpath`.

O resolver:

1. rejeita paths relativos e a própria raiz do filesystem;
2. exige que a root canonical seja uma diretoria;
3. rejeita qualquer alvo cujo `realpath` saia da root, incluindo symlinks;
4. lê apenas ficheiros regulares de 1 a 4096 bytes;
5. rejeita UTF-8 inválido, whitespace periférico e caracteres de controlo;
6. devolve apenas `SecretUnavailable` em falhas, sem expor path ou conteúdo.

`createSecretResolver` suporta `SECRET_PROVIDER=disabled|mounted-file`. Não existe fallback para env, mock ou um segredo global.

O worker automático é controlado por `AI_OUTBOUND_WORKER_ENABLED`, cujo default é `false`. Quando `true`, `parseConfig` exige simultaneamente:

- `SECRET_PROVIDER=mounted-file`;
- `SECRET_MOUNT_DIRECTORY` não vazio;
- `WHATSAPP_MESSAGING_API_VERSION` explícita e validada.

O `worker.ts` só depois resolve a root e compõe `startAIAutomaticOutboundRuntime`. Se a configuração ou o mount forem inválidos, o processo falha antes de iniciar a queue de outbound IA. O shutdown fecha esse consumer antes das filas inbound/outbound partilhadas.

O `docker-compose.yml` apenas propaga as opções com defaults desativados. Ele não monta secrets automaticamente; um operador que queira ativar live deve fornecer explicitamente uma montagem read-only compatível com `SECRET_MOUNT_DIRECTORY`.

## Consequências

- A configuração normal continua incapaz de enviar respostas automáticas live.
- Um tenant pode apontar `credentials_reference` para material distinto dentro da root sem guardar token na BD.
- A fila continua a receber apenas `{id, attempt}`; referências de sender/secret são carregadas da fonte de verdade pelo dispatcher.
- Um mount inexistente ou demasiado amplo falha fechado antes do consumer de IA arrancar.
- O mecanismo é vendor-neutral ao nível da aplicação; um secret manager gerido pode substituir o resolver através da mesma interface no futuro.
- CI e testes usam apenas material sintético em diretórios temporários; não existem credenciais Meta reais nem chamadas live.
- A política do ADR-064 para `MessagingDeliveryUnknown` permanece: outcome externo ambíguo é terminal e não é repetido automaticamente.
- Ativação real continua a exigir validação em staging com um mount read-only e credenciais próprias do ambiente; mocks e testes HTTP injetados não provam comportamento da Meta.
