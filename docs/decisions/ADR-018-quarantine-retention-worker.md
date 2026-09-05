# ADR-018 — Purga automática da quarentena

Estado: implementado no worker, sem ativação real.

## Decisão

Migration 14 cria quarantine_expiry, um índice interno de encaminhamento mínimo com tenant UUID, evento UUID e prazo. Leitura global é uma exceção explícita de RLS, equivalente ao envelope de dispatch; nenhum conteúdo, canal, destinatário ou chave é exposto. O conteúdo cifrado mantém RLS por tenant. Uma FK composta vincula o prazo ao payload, propaga mudanças administrativas e remove o envelope por cascade ao apagar o payload. A migration preenche envelopes dos registos existentes.

Novas capturas criam payload/envelope na mesma transação. Runtime pode inserir envelopes no seu tenant, mas não alterar prazos nem eliminar envelopes diretamente. Não consultar bindings WhatsApp para encontrar expirações: uma ligação removida não deve impedir limpeza de dados.

O worker executa um ciclo ao iniciar e repete dez segundos após terminar o anterior, sem sobreposição no mesmo processo. Cada ciclo trata no máximo 100 registos, ordenados por prazo. Para cada alvo, abre transação com contexto de tenant e DELETE condicionado a expires_at < now(), usando relógio PostgreSQL e a política RLS de expiração existente. Se apagar, regista message.quarantine_purged na mesma transação. Em caso de erro há rollback e nova tentativa num ciclo posterior.

Workers concorrentes não duplicam a auditoria: apenas a transação que efetivamente apaga o registo a grava. Shutdown espera o ciclo em curso antes de fechar a DB. Logs operacionais contêm apenas evento e contagem, sem conteúdo/IDs.

## Retenção efetiva

Apaga ciphertext, nonce, tag e metadados da linha de quarentena após sete dias mais atraso do ciclo/backlog. Mantém external_events/hash/recibo e auditoria; não é eliminação integral de todos os dados do cliente. Replay de um evento expirado devolve o recibo antigo sem repor o conteúdo. Não há recuperação do payload apagado a partir da DB ativa; políticas de backups ainda precisam de ser tratadas.

Não garante purga instantânea ou durante indisponibilidade do worker/DB. Métricas de backlog/alertas, revisão/reprocessamento antes da expiração, gestão de chaves e validação operacional permanecem pendentes. Não ativar tráfego real só com base nesta entrega.

## Verificação

Fixtures sintéticas vencidas por credencial administrativa: scheduler do worker separado limpa mesmo sem binding, preserva conteúdo não expirado e ledger, remove envelope e audita uma vez. Testes adicionais de concorrência entre purgas, proibição runtime de antecipar prazo e replay sem ressurreição. As únicas remoções de validação são dados sintéticos da DB descartável de CI. Schema version 14 obrigatório.
