# ADR-035 — Limite de frequência outbound

API de sandbox: janela fixa de 60 segundos desde a primeira chamada, por utilizador autenticado e operação. POST permite 30 pedidos, GET permite 120, com contadores independentes. O âmbito atravessa os tenants do utilizador: trocar tenant, conversa, sessão ou requestId não contorna o limite. Um utilizador não consome a quota de outro. Não é quota por empresa nem proteção DDoS completa.

Guard executado depois de AuthGuard e antes de validação/autorização de tenant: tentativas autenticadas inválidas ou sem permissão também contam. Chaves incluem apenas hash do UUID do utilizador e operação fixa; IDs arbitrários do caminho não criam contadores. Redis Lua torna consumo e expiração atómicos entre instâncias, satura o contador e repara TTL ausente. Janela fixa pode permitir rajada na fronteira; não é sliding window.

429 devolve Retry-After em segundos. Esperar e reutilizar requestId/texto originais; uma repetição também consome taxa, mas não duplica a intenção. Limite de gravação não impede consultar recibos. Redis indisponível, resposta inválida ou contador corrompido devolvem 503 sanitizado antes do serviço, sem gravar intenção. Reinício/perda de dados Redis pode reiniciar a janela; não é controlo financeiro durável. AuthGuard ainda consulta a sessão antes deste guard.

Testes Redis/HTTP cobrem concorrência exata, saturação/TTL, 429, independência GET, erro fechado, ausência de escrita, recuperação/replay e reparação de TTL. Não simulam indisponibilidade global de rede neste novo cenário. OpenAPI atualizado. Proteção no proxy, limites de IP/tenant e métricas específicas continuam pendentes; sem UI, envio real, schema novo, merge ou deploy.
