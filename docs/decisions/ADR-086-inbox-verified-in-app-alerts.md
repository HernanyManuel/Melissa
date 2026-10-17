# ADR-086 — Alertas visuais do inbox confirmados pelo REST

## Estado

Fatia incremental da Phase 8, em PR draft, sem merge nem deploy.

## Problema

A ADR-085 acrescentou contadores de mensagens recebidas por operador, mas não evidencia uma nova entrada enquanto o operador está a trabalhar no inbox. Eventos SSE contêm apenas identificadores e podem ser repetidos, agregados, atrasados ou corresponder a atividades que não sejam novas mensagens. Notificações não podem ser inferidas a partir do SSE bruto.

## Decisão

- O Flutter conserva um conjunto volátil de IDs de conversas com **incremento confirmado** de `unreadCount`. Apenas uma atualização REST tenant-scoped desencadeada pelo SSE pode produzir o aviso, quando `unreadCount` após o refresh é maior do que o último valor apresentado para a conversa afetada.
- A entrada inicial na página não produz avisos por mensagens antigas; uma alteração de tenant, perda de permissões ou falha fatal limpa o conjunto, impedindo fugas de informação entre contextos.
- Um badge de aviso na AppBar e um bloco no topo da lista mostram quantas **conversas** tiveram incrementos confirmados nesta sessão. O texto é traduzido para pt, en, es, fr, it e de. Não são apresentados conteúdos das mensagens nem IDs de cliente nos avisos.
- Depois da ação explícita de marcar como lida, o alerta dessa conversa desaparece se o recibo corresponde à sequência observada. Atualizações que indiquem `unreadCount=0` limpam o aviso. A recuperação por SSE utiliza os mecanismos preexistentes de reconexão, replay, deduplicação e retries.
- Estes são apenas **avisos visuais dentro da página aberta**. Não há pedido de permissões browser, notificações do sistema, push, emails, sons ou persistência de alertas.

## Segurança e limites

A contagem depende apenas das conversas carregadas, do filtro de pesquisa atual e da página até ao limite já carregado. Não indica o total de não lidas no tenant, e eventos não acessíveis ao operador não são mostrados. O badge conta conversas com **incrementos observados**, não o número total de mensagens por ler. A contagem é transitória e desaparece ao mudar de tenant, sair do inbox ou recarregar a aplicação. Não deve ser apresentada como garantia de entrega de notificações fora da aplicação.

O teste Flutter cobre ausência de alerta na abertura, aumento confirmado por REST após um evento SSE e remoção após marcação explícita como lida. Nenhuma migração ou endpoint novo é necessário.
