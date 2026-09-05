# Motor de IA

## Princípio

A IA interpreta linguagem e propõe intenções; o backend valida e executa ações determinísticas. O modelo nunca acede diretamente ao PostgreSQL, Redis, storage ou credenciais.

## Estado atual

`AIProvider` define o contrato vendor-neutral. `AIGateway` valida contexto e respostas, limita tool calls e rejeita tools não autorizadas. `MockAIProvider` permite testes sem rede. Ver [ADR-053](decisions/ADR-053-ai-provider-gateway-boundary.md).

Ainda não existem chamadas reais a modelos, execução de tools, persistência de estado, integração com conversas ou UI.
