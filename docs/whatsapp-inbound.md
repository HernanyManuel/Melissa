# WhatsApp inbound — adaptador de transporte

Atualização schema 10: a composição interna `WhatsAppIngress.receive` liga validação, routing e outbox para texto de clientes existentes, com worker e auditoria de origem externa. Ver [ADR-013](decisions/ADR-013-external-inbound-outbox.md). Sem endpoint HTTP; as notas abaixo sobre ausência de composição descrevem a etapa anterior. Não configurar Meta para este código ainda.

Atualização schema 9: `WhatsAppRouting.scoped` e registo interno de bindings implementados; ver [ADR-012](decisions/ADR-012-whatsapp-routing.md). Ainda não integrados ao HTTP/adapter/outbox. Provisioning confiável não implementado; nenhum binding real criado. A lista abaixo inclui requisitos de integração end-to-end, não apenas funções isoladas.

Entrega parcial da Phase 4, §§15, 64 e 76. `WhatsAppInboundProvider` implementa o contrato `InboundProvider`, sem dependência de Nest, DB ou rede. Não está ligado a qualquer rota HTTP e não permite receber mensagens reais na aplicação.

## Contrato implementado

- `verifyChallenge(query)`: verifica modo subscribe, token em tempo constante e challenge numérico escalar. Devolve o challenge sem o converter em número.
- `decode(rawBody, signature)`: verifica HMAC-SHA256 sobre os bytes originais antes de descodificar UTF-8/JSON; rejeita headers ausentes, duplicados ou malformados.
- Normaliza todas as entradas e alterações messages, com mensagens text e callbacks sent/delivered/read/failed separados. IDs externos e timestamp em segundos mantêm-se strings; nunca são IDs de tenant.
- Eventos desconhecidos/media são contados em `unsupported`, não transformados silenciosamente em texto. Nenhum resultado implica autorização, dedupe, persistência ou confirmação HTTP.
- Limites locais: corpo 256 KiB, 20 entradas, 100 alterações por entrada e 100 mensagens/statuses por alteração. Payload malformado falha integralmente, sem devolver resultados parciais. Erros não incluem conteúdo ou secrets.

## Antes de ligar o endpoint

Ainda implementar: raw-body e limite no servidor/proxy; configuração server-side dos secrets; resolução verificada de WABA/phone_number_id para canal ativo e tenant; cliente pelo remetente; idempotência e outbox para eventos reais; política durável de quarentena de tipos desconhecidos; persistência monotónica de estados; rate limiting e testes HTTP de isolamento. Só confirmar receção depois do commit. Uma assinatura válida não identifica por si só uma empresa autorizada, nem impede replay.

O consumidor não deve confirmar um pedido que tenha `unsupported > 0` sem guardar os eventos não suportados numa estratégia durável explicitamente definida. Este adaptador não retém payloads nem resolve esse requisito sozinho.

Credenciais futuras: `WHATSAPP_APP_SECRET` para assinatura, `WHATSAPP_VERIFY_TOKEN` escolhido pelo operador para verificação inicial, access token para APIs de gestão/envio. Nenhuma credencial é necessária para os testes; os valores neles são sintéticos. Não colocar secrets em Flutter, logs ou Git. Outbound, media e onboarding Meta permanecem pendentes.

## Fontes e testes

Contrato consultado na documentação oficial Meta: [verificação do endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/), [eventos messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages) e [texto](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text).

`test/whatsapp-inbound.test.ts` é incluído pela suite unitária existente. Cobre bytes originais, Unicode, adulteração, assinaturas inválidas, challenge/token, múltiplas entradas, estados, tipos desconhecidos e payloads malformados/limitados. Integração real com Meta não executada.
