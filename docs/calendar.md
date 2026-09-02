# Calendário e sincronização

CalendarProvider suporta interno, Google e mock. PostgreSQL conserva bookings; Google espelha reservas e fornece ocupação externa. Conflitos e staleness são estados visíveis, não sucesso silencioso.

## OAuth e watch

Connect exige integração.write e reautenticação quando relevante. Backend cria state aleatório, de uso único, com hash, expiração, user/tenant/session e redirect allowlist; usa PKCE quando suportado. Callback valida state, troca código server-side e guarda token cifrado/referência. Nunca tokens em URL do Flutter, logs ou client secrets no browser. Scope mínimo compatível com leitura de ocupação e escrita autorizada; refresh serializado por conexão; invalid_grant marca disconnected.

Google push usa channel ID/token e resource ID, não a assinatura HMAC usada por Stripe/WhatsApp. Validar token de alta entropia, IDs, expiração e conexão; comparar token de forma segura. Notificação é sinal para buscar dados pela API autenticada, não payload de booking confiável. Renovar watch antes de expirar ([documentação Google](https://developers.google.com/workspace/calendar/api/guides/push)). Esta adaptação explícita de §76 preserva autenticidade sem inventar uma assinatura.

## Sync

Guardar sync token por conexão, processar paginação completa e só publicar checkpoint após sucesso. Se token inválido/410, limpar checkpoint e executar full sync; tokens e parâmetros associados devem manter-se consistentes ([guia de sincronização](https://developers.google.com/workspace/calendar/api/guides/sync)). Busy intervals armazenam só intervalo necessário, não títulos/dados privados de eventos externos.

Outbox de booking gera upsert por link local e ID externo estável/determinístico permitido pelo provider; guardar ETag/versão. Origem/version impede loop de sync. Reschedule/cancel geram eventos separados idempotentes. Se utilizador edita no Google um evento criado pelo Melissa, registar conflito e pedir resolução; não alterar booking interno sem validação. Recorrências, all-day e timezone tratados no adapter.

Política proposta: external availability obrigatório deve ter sync fresco (limite configurável inicial 60s) e revalidação quando necessário; provider indisponível bloqueia confirmação desse recurso. Calendar interno não tem essa dependência. Corridas com alterações externas continuam possíveis e são reconciliadas.

## Operação e testes

Watch renewal, polling/reconciliação periódicos, alertas por atraso, revogação e falhas permanentes. Testar OAuth state replay/mismatch, troca de tenant, token expirado/revogado, paginação, 410, duplicate push, retry após timeout, recorrências/DST e conflito externo. Integração real com conta Google de teste é gate P7.
