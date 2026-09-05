# ADR-048 — Rotação limitada das chaves de quarentena

## Estado

Aceite em 2026-09-05.

## Decisão

`WHATSAPP_QUARANTINE_KEY_ID` e `WHATSAPP_QUARANTINE_KEY` continuam a identificar exclusivamente a chave de escrita. `WHATSAPP_QUARANTINE_PREVIOUS_KEYS` aceita até quatro entradas `key-id=base64`, separadas por vírgula, usadas somente para decriptar payloads existentes durante uma rotação.

Todos os IDs e materiais têm de ser únicos. Cada chave tem exatamente 32 bytes e representação base64 canónica. Chaves anteriores sem uma chave atual, espaços, entradas vazias, duplicações ou conjuntos acima do limite impedem o arranque. Não existe fallback, derivação automática ou seleção pela ordem da lista.

O keyring devolve cópias defensivas. O webhook recebe apenas a chave atual; o processador de media poderá resolver pelo `keyId` persistido sem tornar uma chave anterior apta a cifrar novos dados.

## Operação

1. Adicionar a chave atual à lista anterior e configurar uma nova chave/ID atual no mesmo rollout.
2. Manter a chave anterior até expirar/purgar toda a quarentena que a referencia.
3. Confirmar por métricas/auditoria que já não existem referências antes de a remover.

Os valores continuam exclusivamente server-side. Este mecanismo não substitui um secret manager, versionamento externo, rotação automática ou procedimento de recuperação.
