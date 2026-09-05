# ADR-017 — Quarentena cifrada por tenant

Estado: implementado, opt-in, sem ativação real.

## Decisão

Mensagens não textuais e estados desconhecidos com WABA/phone/message_id/timestamp válidos podem ser guardados numa quarentena. O adapter preserva os campos da mensagem/status não suportado, sem copiar o request inteiro ou dados de outras entradas/empresas. Eventos sem âmbito de canal seguro continuam recusados; não há fallback global.

Exige chave independente AES-256-GCM (32 bytes, base64) e key ID server-side. Nonce aleatório de 12 bytes por registo, tag de 16 bytes e AAD vinculada a tenant/canal/evento/key ID. A chave não é persistida na DB. Metadados do envelope e hashes não são cifrados; o conteúdo da mensagem é cifrado. A aplicação continua capaz de decifrar com a chave: isto não é isolamento perante runtime comprometido.

Registo de evento, payload cifrado e auditoria são transacionais. Chave idempotente inclui canal/categoria/message_id/timestamp; payload hash usa JSON canónico com limite de profundidade. Replays com ordem diferente de propriedades não duplicam. Conteúdo divergente gera conflito auditado, sem sobrescrever o primeiro registo. Namespace separado dos eventos processáveis.

HTTP confirma apenas após persistência. Eventos suportados do mesmo request continuam a ser processados; commits são por evento. Quarentena não cadastra cliente, não cria jobs de conversa, não descarrega media e não envia conteúdo à IA. processedAt significa captura concluída, não resolução do evento.

## Retenção e limites operacionais

Migration 13: RLS forçada, FKs compostas, sem UPDATE runtime. Payload recebe expiresAt de sete dias e limite de 1000 registos por tenant. DELETE runtime só permite registos expirados no tenant atual. expiresAt define elegibilidade, NÃO garante eliminação física: scheduler/rotina operacional de purga ainda pendente. Não ativar tráfego real sem essa rotina, alertas, revisão/reprocessamento e gestão/rotação das chaves. Preservar chaves anteriores até terminar o prazo dos payloads associados. Nunca guardar a chave no repositório.

Sem chave, capacidade esgotada, falha de DB ou âmbito não resolvido: não há ACK de sucesso. Eventos desconhecidos de conta (sem canal) ainda podem causar retries; não declarar cobertura de todos os webhooks Meta.

## Verificação

Testes com chave sintética: assinatura/rota inválidas, concorrência/dedupe, reordenação de JSON, conflito, decriptação exata, AAD de outra empresa rejeitada, ausência de criação de cliente/job, leitura cross-tenant negada, eliminação prematura negada e HTTP ACK só depois de armazenamento cifrado. Migrations/testes completos nos checks do PR #5.
