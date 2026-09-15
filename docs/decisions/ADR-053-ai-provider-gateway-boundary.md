# ADR-053 — Fronteira AIProvider e AIGateway

## Estado

Aceite em 2026-09-05.

## Decisão

Todo o acesso futuro a modelos passa por `AIProvider` e `AIGateway`. O provider recebe apenas prompt de sistema, mensagens, tools declaradas e limite de saída. `tenantId` e `correlationId` permanecem no gateway para futura autorização, auditoria e metering; não são enviados ao modelo por defeito.

O gateway limita contexto, quantidade/tamanho das mensagens, tools, schemas, argumentos e output tokens. Nomes de tools têm formato estrito e são únicos. Uma resposta só pode chamar tools presentes no pedido; IDs de chamada são únicos e argumentos têm de ser JSON finito, limitado em profundidade/tamanho e sem chaves de prototype pollution.

O LLM não recebe cliente de base de dados nem executa ações. Este contrato apenas descreve uma intenção. O futuro `ToolExecutor` terá de autorizar tenant, ator e estado novamente antes de executar software determinístico.

Falhas e respostas inválidas do provider são convertidas em `AICompletionFailed`, sem propagar detalhes, prompts, credenciais ou respostas brutas. `MockAIProvider` é determinístico, sem rede/DB e usa cópias defensivas.

## Limites

- Ainda não existe adapter OpenAI, persistência, routing de modelos, metering ou execução de tools.
- O gateway não é proteção completa contra prompt injection; construção de contexto, classificação de conteúdo e políticas por tool serão incrementos separados.
- Os schemas são transportados como JSON validado; validação semântica dos argumentos pertence ao futuro registry/executor.
