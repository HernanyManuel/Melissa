# ADR-014 — Cadastro de cliente a partir de texto WhatsApp verificado

Estado: implementado no ingresso interno; sem endpoint público ou envios.

## Decisão

Depois de verificar assinatura, binding e canal ativo, e depois de deduplicar o evento, resolver cliente por tenant + telefone E.164. O índice único existente e o lock do tenant serializam o cadastro concorrente. Nenhum ID de cliente/tenant fornecido pelo remetente é aceite.

Um cliente novo é criado na mesma transação do evento/outbox/lote/auditoria. Falhas posteriores desfazem também o cadastro. Nome inicial é o próprio telefone, sem inventar uma identidade ou copiar perfis de outra empresa. Idioma inicial usa o locale da empresa, como fallback de interface, não deteção do idioma do remetente. Perfil/idioma existentes não são sobrescritos.

Cliente arquivado continua reservado e não é reativado: evento novo é recusado. Replay de evento já aceite devolve o recibo anterior sem recriar o cliente; se ainda pendente, o worker volta a verificar o arquivo antes de criar a mensagem.

Migration 11 adiciona marketing_consent_status e whatsapp_opt_in_status com estados unknown/granted/denied, default unknown e constraints. Registos existentes recebem unknown; não há inferência de autorização a partir de inbound. O ingresso não altera estados existentes. Não foi criada API de concessão de consentimento; recolha de evidência, histórico, gestão UI e regras de envio permanecem pendentes. Nenhum envio é ativado por estes campos.

Auditoria `customer.whatsapp_created` usa origem WhatsApp, actor_id nulo e apenas ID do alvo, sem telefone ou texto nos dados da auditoria. Mensagens recebidas não são usadas como nomes, notas ou consentimento.

## Verificação

Integração com PostgreSQL/worker: duas mensagens concorrentes criam um cliente e uma auditoria; telefone igual noutro tenant não partilha dados; assinatura inválida não cadastra; rollback elimina cadastro parcial; cliente arquivado não reaparece; telefone inválido é recusado; nome/consentimentos existentes preservados; mensagens dos novos clientes são processadas. O padrão E.164 do ingresso é alinhado com o cadastro manual.

## Limites

Sem controller público, provisioning Meta, callbacks/status, media, identificadores não telefónicos, outbound, IA ou produção. Campos restantes do §13, edição dos estados de consentimento e tratamento durável de recusas permanecem pendentes. Aplicar migration 11 antes de reiniciar API/worker; readiness exige schema 11.
