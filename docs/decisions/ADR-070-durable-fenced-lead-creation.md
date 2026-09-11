# ADR-070 — Criação de lead durável e fenced pela IA

## Estado

Proposto.

## Contexto

A tool `create_lead` precisa transformar intenção comercial explícita da conversa num registo durável sem permitir ao modelo escolher tenant, customer, conversation, turn ou epoch. O contrato alvo exige input limitado e deduplicação por ação.

Reutilizar `Customer.notes` misturaria perfil com workflow comercial, dificultaria idempotência e poderia incentivar cópia desnecessária de contacto. Também não existe ainda um domínio de leads anterior que possa ser reutilizado com segurança.

## Decisão

Introduzir a tabela tenant-scoped `leads` e a tool server-owned `create_lead`.

Cada lead guarda somente:

- `tenant_id`, `customer_id`, `conversation_id` e `turn_id` derivados do contexto confiável;
- `idempotency_key` server-side por `turnId:callId`;
- SHA-256 canónico dos argumentos para distinguir replay de conflito;
- `topic` limitado a 120 caracteres;
- `details` limitado a 1000 caracteres;
- estado inicial fixo `new` e timestamp.

A tool não recebe nem copia telefone/email. O customer é referenciado pela FK composta existente.

A execução é live-only. Dentro da mesma transação PostgreSQL:

1. aplica `app.tenant_id` para RLS;
2. tenta inserir o lead pela idempotency key;
3. replay com scope + fingerprint idênticos devolve `duplicate: true`; fingerprint/scope divergentes falham como conflito;
4. bloqueia a conversation e exige `AI_ACTIVE` com `mode_epoch` exatamente igual ao epoch confiável do turno;
5. grava audit único `ai.lead_created` apenas no primeiro efeito.

Erro de fence ou cancelamento aborta a transação inteira, portanto não deixa lead parcial. Sandbox falha antes de abrir a mutação live.

A capability é `customer.lead.create`; o runtime só autoriza a tool quando ela está registada server-side.

## Consequências

- Leads são uma fonte separada de `Customer.notes` e não duplicam contacto.
- Idempotência é durável e não depende de memória do worker.
- Takeover humano ou mudança de modo invalida writes antigas via `mode_epoch`.
- O schema 28 adiciona RLS forçada e grants mínimos para `melissa_runtime`.
- A tabela começa deliberadamente pequena; ownership, assignment, lifecycle comercial e APIs de gestão ficam para uma fase posterior e exigirão migrations explícitas.

## Validação

A cobertura inclui schema estrito/capability em unitários e integração PostgreSQL real para criação, replay exato, conflito de idempotência, epoch obsoleto, sandbox, audit único e ausência de writes residuais.
