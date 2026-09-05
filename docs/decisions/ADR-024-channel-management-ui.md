# ADR-024 — Gestão visual de canais de teste

Estado: incremento funcional da Phase 4.

## Decisão

Página Flutter `/channels/:tenantId`, acessível pela conta para owner/admin, ligada às APIs existentes de listagem, criação mock e disconnect. A autorização visual não substitui a validação de sessão, membership, `channels:manage` e RLS no backend.

Permite criar canal mock com nome obrigatório até 160 caracteres e listar até ao limite existente de 100 canais, incluindo desligados. O formulário não liga números reais e explica que os dados de teste ficam persistidos no tenant. Canais live são apenas de consulta nesta interface; provisioning Meta continua pendente.

Disconnect de canal mock ativo exige confirmação explícita: impede novas entradas, pode rejeitar mensagens ainda na fila e preserva histórico. Não elimina dados nem apresenta opção de reativação inexistente.

## Estados e segurança

Seis idiomas, layout mobile/desktop, carregamento, vazio, erro, campos/botões bloqueados durante pedidos. Respostas atrasadas são ignoradas após mudança de tenant. Na falha da listagem remove metadados; numa mutação sem confirmação remove ações e orienta a atualizar/verificar antes de repetir. Não repete automaticamente erros de rede. A criação não possui idempotência de negócio: recarregar e conferir o resultado é obrigatório antes de repetir uma tentativa incerta.

Testes widget cobrem validação/criação, confirmação/cancelamento de disconnect, acesso negado, falha de rede sem repetição, canal live apenas leitura e resposta tardia cross-tenant em mobile. Backend/RBAC/isolamento/disconnect idempotente já possuem testes de integração e são reexecutados na CI.

## Limites

Não inclui envio/simulação de mensagens pela UI, conexão WhatsApp real, edição, remoção ou reativação de canais. Não é conclusão da Phase 4. Sem migration, alteração do contrato backend, merge ou deploy.
