# WhatsApp e processamento de mensagens

WhatsApp Business Platform server-side, por MessagingProvider. Credenciais e onboarding do provider descritos em integrações; não criar um bot/workflow por tenant.

## Ingress

GET verifica challenge com verify token configurado. POST verifica assinatura com app secret sobre bytes originais antes de normalizar. Extrair cada mensagem/status de batches; resolver external phone/account para conexão única ativa. Transação persiste evento durável, inbound e outbox. ACK rápido (<1s como target), sem IA nem chamada de envio inline. Se commit falha, devolver erro para retry do provider; se fila está indisponível após commit, outbox recupera.

Dedupe em provider/external_event_id. Eventos de status podem precisar de chave derivada do message ID + status + provider timestamp. Mensagem repetida não reabre conversa nem duplica resposta lógica. Payload diferente para mesma chave gera alerta; nunca sobrescreve histórico silenciosamente. Eventos sem tenant resolvido vão para quarentena de ingress sanitizada, sem escolher tenant default.

## Saída

Outbound intent persistido antes do envio, com chave de ação única. Worker valida modo/epoch, estado tenant, permissões de envio e regras vigentes do provider. Provider devolve external_message_id; delivery callbacks atualizam estados de forma monotónica. Timeout após envio é ambíguo: registar `delivery_unknown`, reconciliar quando possível e evitar retry cego que possa duplicar mensagem. Não prometer exactly-once no provider.

As regras vigentes de janela de atendimento, templates e opt-in têm de ser confirmadas na documentação Meta na P4 e codificadas no adapter; não embutir pressupostos comerciais nesta Phase 0. Falha de autorização/token suspende conexão e notifica equipa. Media guardada em storage privado após validação.

## Verificação P4

Challenge certo/errado, assinatura inválida, byte payload alterado, batches, duplicados simultâneos, status fora de ordem, conexão revogada, tenant desconhecido, crash depois de commit, Redis indisponível, retry outbound ambíguo e human takeover durante inferência. Sandbox/mock não envia a números reais. Smoke test com conta Meta de teste é evidência separada.
