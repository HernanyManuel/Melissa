# ADR-059 — Loop conversacional limitado e protegido por epoch

## Estado

Aceite para o incremento atual da Phase 5.

## Decisão

`ConversationEngine` coordena provider e tools em até quatro rondas e oito tool calls totais. Cada ronda reusa o contrato neutral; chamadas e resultados são adicionados como itens tipados `tool_call`/`tool_result`. O adapter Responses converte-os para `function_call` e `function_call_output` sem expor detalhes do executor.

Antes de cada inferência, depois da resposta do provider, antes de cada tool e antes de devolver texto final, o engine consulta `ConversationFence`. O adapter Prisma só considera atual uma associação tenant/conversation/customer em `AI_ACTIVE` com o `mode_epoch` esperado. Uma mudança de modo durante inferência impede tools ou resposta do worker antigo.

As tools são executadas sequencialmente para permitir fencing entre efeitos. Resultados contêm apenas `success`, output validado ou código de erro sanitizado. Usage é acumulado por ronda. Exceder rondas ou tools devolve `handoff_required`; não tenta continuar autonomamente.

## Consequências e limites

- O provider nunca executa handlers nem escolhe contexto de segurança.
- Um takeover observado antes do próximo boundary interrompe o turno.
- Oito tools numa resposta são executadas apenas com fencing individual.
- Ainda não existe worker que invoque o engine, persistência do turno, reserva de custo, auditoria, outbound ou transição automática efetiva para handoff.
- Uma tool externa deve continuar idempotente: o epoch não desfaz efeitos aceites entre duas verificações.
