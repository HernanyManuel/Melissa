# Riscos, ambiguidades e decisões pendentes

Decisões técnicas abaixo permitem avançar sem inventar requisitos. Questões comerciais/externas só bloqueiam o módulo correspondente, não a infraestrutura.

| ID | Questão / risco | Decisão proposta e momento de resolução |
|---|---|---|
| R01 | Double booking e staff opcional | Recurso obrigatório default/staff + constraint PostgreSQL; P6 prova concorrência |
| R02 | Escrita DB seguida de queue pode perder evento | Outbox/receipts desde primeiro efeito assíncrono; testes de crash P4 |
| R03 | RLS com pool/admin pode dar falsa segurança | Runtime não-owner, contexto local transacional, FKs e testes com runtime role; P2 |
| R04 | Sandbox criar booking real | Repositories separados e providers sem efeitos live; não mero campo booleano confiado à IA; P5 |
| R05 | Takeover enquanto IA gera/envia | Epoch e autorização final; envio já em trânsito pode chegar; P8 |
| R06 | Google externo não partilha transação | Staleness e reconciliação explícitos; não prometer exclusão externa absoluta; P7 |
| R07 | §76 pede assinatura para todos os webhooks | Google usa channel token/IDs + fetch autenticado; ADR-005; validar na P7 |
| R08 | “Conversa” faturável não definida | Proposta sessão 24h inatividade; confirmar unidade, extras, trial/grace/proration antes de cobrar, P9 |
| R09 | Starter sem Inbox/handoff nos exemplos vs safety obrigatória | Handoff de segurança/notificação sempre; entitlement pode restringir funcionalidades avançadas de Inbox, não deixar cliente sem fallback; catálogo a confirmar P9 |
| R10 | Custos estimados visíveis no dashboard vs dados internos | Utilização e preço comercial ao owner; custos/margens do provider só à plataforma; confirmar necessidade de exposição adicional P10 |
| R11 | Meta/Google onboarding pode exigir revisão externa | Implementar fluxo self-service e testes cedo; permissões e domínio/contas antes do live |
| R12 | Promessa 10.000 tenants sem sizing | Medir baseline, fairness/backpressure e ampliar por carga; não assumir escalabilidade comprovada |
| R13 | UI de 10 passos e domínio de 12 | Agrupar apresentação sem remover políticas/conta/ativação; mapping em Flutter UX |
| R14 | Prazo de retenção, impostos e termos | Decisão específica antes de clientes reais; não inferir legislação/tributação |
| R15 | Provedor de hosting/email e região | Escolher por requisitos de residência, operação/custo; email antes P2 live, hosting antes staging |
| R16 | Preços e versões de modelos/API mudam | Config versionada, budgets, versões fixadas nos adapters e docs oficiais verificadas na implementação |
| R17 | Auth build vs managed | Backend auth por agora (ADR-002); exige testes/rotação/recuperação; rever se fornecedor reduzir risco sem violar frontend/backend |
| R18 | Billing implementado após AI/booking | Interfaces/ledger mínimo antes; nenhuma ativação production sem entitlement real |
| R19 | Estados status/mode duplicados | Mode governa automação, status governa lifecycle; transições centralizadas impedem combinações inválidas |
| R20 | Métrica de automação pode ser enganadora | Preservar fórmula §38; definir período/cohort e resolvidas sem humano; mostrar denominador, não substituir por percentagem de mensagens |

Nenhuma decisão acima altera `SPECIFICATION.md`. Se revisão mudar um requisito, registar explicitamente o motivo, impacto e aprovação em ADR/PR; sem apagar histórico.
