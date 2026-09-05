# ADR-036 — Interface outbound de sandbox

Conversas mock oferecem uma página dedicada de intenção de teste. Antes do formulário, consulta canais pela API owner/admin e verifica canal WhatsApp mock ativo. A API de aceitação continua a autoridade sobre conversa/cliente e permissões atuais; esconder controlos não substitui RBAC.

Texto e UUID de pedido são congelados na primeira tentativa e reutilizados em erros incertos/429. Não há retry automático de POST por erro genérico. Retry-After numérico é lido pelo cliente HTTP, limitado a uma hora e aplicado à repetição (fallback 60s); isso não altera a quota do servidor. A consulta do recibo usa GET e nunca reenvia. A UI só confirma stored após validar a resposta. Nunca mostra queued/sent/delivered nem adiciona a intenção ao histórico de mensagens.

O UUID/payload vivem apenas na memória da página. Fechar/recarregar perde a recuperação da chave; aviso explícito orienta a confirmar o anterior antes de novo pedido. Não há persistência local de texto sensível nem recuperação após reload. Nova intenção só é oferecida após confirmação do armazenamento. Erros de autorização/elegibilidade/conflito bloqueiam nova submissão. Trocas de tenant/conversa invalidam respostas pendentes e limpam campos/timers.

Sete textos em seis idiomas, layout limitado em largura e com scroll, estado de carregamento/erro/bloqueio/limite. Testes widget: replay exato, GET sem reenvio, espera 429, canal live bloqueado e resposta tardia. Flutter indisponível localmente; CI faz análise, testes e build Web. Sem envio, nova migration, merge ou deploy. Dispatch/worker e recuperação durável do rascunho continuam pendentes.
