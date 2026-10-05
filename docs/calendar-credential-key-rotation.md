# Rotação da chave de credenciais Calendar

As credenciais Google Calendar são cifradas em `calendar_credentials` com AES-256-GCM. Cada row persiste o `key_id`, e esse ID faz parte do AAD autenticado. A chave atual e as chaves anteriores são carregadas apenas no servidor.

## Configuração

A chave de escrita atual usa:

- `GOOGLE_CALENDAR_CREDENTIAL_KEY_ID`
- `GOOGLE_CALENDAR_CREDENTIAL_KEY_REF`

Chaves anteriores temporariamente aceites durante uma rotação usam `GOOGLE_CALENDAR_CREDENTIAL_PREVIOUS_KEYS`, um array JSON de objetos `{"id","reference"}`. Um mesmo `key_id` nunca pode representar materiais criptográficos diferentes.

Exemplo de transição de `calendar-v1` para `calendar-v2`:

```env
GOOGLE_CALENDAR_CREDENTIAL_KEY_ID=calendar-v2
GOOGLE_CALENDAR_CREDENTIAL_KEY_REF=secret://calendar/credential-key-v2
GOOGLE_CALENDAR_CREDENTIAL_PREVIOUS_KEYS=[{"id":"calendar-v1","reference":"secret://calendar/credential-key-v1"}]
```

## Procedimento seguro

1. Primeiro, garantir que todas as instâncias executam uma versão que suporta keyrings versionados. Não alterar ainda a key atual se ainda existirem instâncias antigas.
2. Provisionar a nova key com um novo ID. Nunca substituir bytes mantendo o mesmo ID.
3. Fazer rollout completo com a nova key como atual e todas as keys antigas ainda configuradas em `GOOGLE_CALENDAR_CREDENTIAL_PREVIOUS_KEYS`.
4. Confirmar que não restam instâncias do rollout anterior. O sweep não deve correr durante um rolling deploy em que uma instância antiga ainda só conheça a key antiga.
5. Executar num job operacional com o runtime DB role e os mesmos mounted secrets:
   ```sh
   pnpm --filter @melissa/backend calendar:rotate-credential-key
   ```
6. O comando termina com `status=complete` apenas depois de não encontrar mais rows com `key_id` diferente da key atual. A descoberta cross-tenant devolve apenas IDs mínimos; cada leitura/re-encriptação real volta ao RLS do tenant e bloqueia a row antes de substituir nonce, ciphertext, tag e `key_id`.
7. Se o comando falhar, manter todas as keys antigas montadas e corrigir o bloqueio. Não retirar material antigo.
8. Depois de um sweep concluído e sem writers antigos, retirar as entradas antigas de `GOOGLE_CALENDAR_CREDENTIAL_PREVIOUS_KEYS`, fazer novo rollout e só então retirar os ficheiros das keys antigas.

Durante leituras normais, uma credencial encontrada sob uma key anterior também é re-encriptada de forma lazy para a key atual. O sweep existe para cobrir credenciais inativas e permitir retirar keys antigas sem depender de tráfego.

## Rollback

Antes do sweep, é possível voltar à configuração anterior. Depois de o sweep começar, algumas rows podem já estar em `calendar-v2`; por isso, qualquer rollback tem de manter `calendar-v2` disponível no keyring. Voltar para uma versão que só conheça `calendar-v1` pode tornar credenciais já migradas indecifráveis.
