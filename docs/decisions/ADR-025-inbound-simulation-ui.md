# ADR-025 — Simulação inbound pela interface

Estado: incremento funcional da Phase 4.

## Fluxo

A página `/channels/:tenantId/:channelId/simulate` abre a partir de um canal mock ativo. Confirma acesso à listagem de canais e o modo/estado antes de carregar clientes ativos, paginados em grupos de 50. O backend continua responsável por sessão, membership, tenant, canal, cliente e autorização no ingresso e no worker.

O utilizador escolhe cliente e texto (não vazio, até 4096 caracteres). Um UUID v4 criado com Random.secure identifica a tentativa. O primeiro envio congela cliente/texto/UUID em memória; falhas de rede permitem repetir exatamente o mesmo payload, sem criar outro identificador. HTTP 202 é mostrado como pendente, nunca como mensagem já processada.

O botão de consulta usa apenas GET do recibo. Estados processed/rejected/failed são apresentados separadamente; não há polling nem reenvio automático. Só depois de um estado terminal se oferece uma nova simulação. O histórico pode ser aberto pela página de conversas.

## Segurança e limites

Sem WhatsApp externo, credenciais, execução IA ou resposta automática. É simulação de entrada que escreve dados reais de teste no tenant e usa a fila/worker reais, não um sandbox descartável da IA. Canais live/desligados não apresentam formulário; a API também rejeita esses usos.

Seis idiomas, loading/erro, botões bloqueados em voo, proteção de respostas atrasadas após troca de tenant/canal. Erros 400/401/403/404/409 bloqueiam a operação e removem campos sensíveis da vista. Em erro de rede preserva a tentativa apenas na memória desta página: recarregar/fechar perde o identificador. A UI orienta a manter a página aberta para repetir a mesma tentativa; não promete idempotência entre sessões/reloads. Nenhum payload é gravado em localStorage.

Testes widget: replay com mesmo corpo após resposta perdida, consulta sem reenvio, modo live bloqueado, resposta tardia cross-tenant mobile. Teste UUID verifica formato/versão/variante. Integrações existentes verificam backend/worker e são reexecutadas na CI. Não conclui Phase 4. Sem migration, merge ou deploy.
