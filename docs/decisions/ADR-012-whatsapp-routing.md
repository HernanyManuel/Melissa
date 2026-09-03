# ADR-012 — Encaminhamento WhatsApp antes de existir contexto de tenant

Estado: implementado, sem ligação ao HTTP/outbox.

## Decisão

Migration 9 cria `whatsapp_routes`, um registo mínimo interno: integração server-side, WABA, phone_number_id, tenant e canal. FKs compostas impedem associação cross-tenant. O runtime pode ler, mas não inserir, alterar ou apagar bindings. Não contém secrets, números de clientes ou mensagens, nem possui endpoint de listagem.

Tal como o envelope de dispatch (ADR-010), este registo tem uma exceção explícita de leitura global à política habitual por tenant. RLS permanece forçada; a leitura global só existe nesta tabela, não em channels/customers. A credencial runtime comprometida pode enumerar estes metadados. Separar credenciais de ingress/provisioning é requisito antes de produção.

`WhatsAppRouting.scoped` recebe a integração pela configuração do servidor, nunca pelo payload. Depois da verificação da assinatura, procura a combinação exata integração/WABA/phone. Abre transação com contexto de tenant, bloqueia o tenant e volta a verificar o binding e o canal: live, WhatsApp, ativo e IDs externos coincidentes. Executa o callback no mesmo contexto transacional; não devolve um contexto reutilizável fora da transação.

Provisioning futuro deve verificar posse do WABA/número com Meta antes de criar bindings. Alteração/revogação administrativa de bindings deve bloquear primeiro o tenant, tal como o resolver, e registar auditoria. Migração não cria bindings reais; a aplicação não disponibiliza API para os escrever.

## Limites preservados

Não há endpoint público, provisioning Meta, resolução de cliente ou escrita de eventos reais na outbox. Esta ainda exige actor_id de utilizador para o caminho mock. A próxima mudança deve modelar explicitamente a origem externa e a auditoria de sistema, sem inventar utilizadores nem desativar autorização do caminho mock. Assinatura válida não substitui binding autorizado. Não há fallback para canal mock.

## Testes

A suite descartável de integração usa a credencial de migration apenas para criar fixtures sintéticas. A execução do resolver usa melissa_runtime. Verifica binding exato, app/WABA/phone errados, canal alterado/revogado, isolamento RLS, contexto sem fuga após transação, FKs cross-tenant e proibição de escrita runtime. Não constitui validação com Meta real. Readiness exige schema 9.
