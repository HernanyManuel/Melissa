# Flutter e experiência do utilizador

Objetivo: o empresário consegue configurar e operar o assistente sem conhecer tenants, tokens, filas ou modelos de IA. Termos visíveis: Empresa, Assistente, Conversas, Agenda, Equipa, Integrações e Plano.

## Arquitetura

Flutter Web principal, código compatível com Android/iOS sem exigir lançamento nativo no MVP. Riverpod para state/dependency injection; go_router como escolha de router declarativo. Features com `data/` (DTOs/client/repositories), `domain/` (modelos/use cases) e `presentation/` (providers/controllers/widgets). `core/api`, `core/auth`, `core/config`, `core/errors`, `core/localization`, `core/theme` e `shared/widgets` tratam capacidades comuns. Não mover regras de booking, limites ou RBAC para widgets.

Cliente Dart gerado a partir de OpenAPI, envolvido por repositories. Estados assíncronos explícitos, cancelamento de pedidos obsoletos e cache por tenant. Troca de empresa elimina todos os providers dependentes; nenhuma resposta atrasada da empresa anterior atualiza o ecrã atual.

## Navegação

Páginas públicas: landing, pricing, login, register, forgot/reset password, privacy e terms. App: onboarding, dashboard, conversations/:id, bookings, customers, services, staff, analytics, integrations, billing e settings. Admin tem shell e guards próprios com tenants/:id, subscriptions, jobs, incidents, usage e audit.

Desktop: sidebar, seletor de empresa, breadcrumbs quando úteis e uma ação principal por página. Tablet: navegação recolhível. Mobile: menu/bottom navigation para destinos frequentes, detalhe em ecrã próprio, sem comprimir tabelas de três painéis. Deep links preservam destino após login e validam autorização.

## Sistema visual inicial

Material 3 personalizado; superfícies neutras, cor de marca configurada em tokens, hierarquia tipográfica legível, grelha de espaçamento 4/8, raios e elevação consistentes. Cor final da marca é ajustável sem alterar lógica. Evitar gradientes/decorativos que disputem atenção com conteúdo. Tabelas com pesquisa, filtros, cabeçalhos e ações claras; datas e montantes formatados pelo locale.

Critérios de acessibilidade propostos: WCAG 2.2 AA, foco visível, navegação por teclado, Semantics/labels, contraste de texto normal >=4,5:1, alvos principais de toque >=48 logical pixels, zoom/text scaling e reduced motion. Estado nunca identificado só por cor. Testar leitor de ecrã no browser-alvo; estas metas ainda não foram verificadas numa UI.

## Onboarding: preservar os 12 passos sem formulário gigante

| Etapa do domínio (§8) | Apresentação e comportamento |
|---|---|
| 1 Conta | Nome/email/password, consentimentos, verificação; concluída antes do wizard |
| 2 Empresa | País sugere idioma/moeda/timezone; em países com múltiplos fusos, pedir seleção |
| 3 Serviços | Nome, preço/moeda, duração; opções avançadas para buffers/categoria |
| 4 Horário | Copiar horário entre dias; múltiplos intervalos; exceções e fechado |
| 5 Funcionários | Opcional; omitir cria recurso interno único, sem funcionário fictício |
| 6 FAQs | Sugestões editáveis por indústria; nada publicado sem revisão |
| 7 Políticas | Secção própria em “Assistente”, todas as políticas de §8 preservadas |
| 8 Personalidade | Tom, emojis, nome, idioma e verbosidade; preview identificado como teste |
| 9 Integrações | Duas tarefas visíveis: WhatsApp e Agenda; agenda interna permite continuar |
| 10 Plano | Preço, limites, extras e estado de pagamento transparentes |
| 11 Testar | Motor real em sandbox; banner “Teste — sem mensagens ou reservas reais” |
| 12 Ativação | Resumo/checklist final e botão “Ativar assistente”; resultado server-side |

As dez etiquetas de progresso do §80 agrupam estes passos; não removem conta, políticas ou ativação. Autosave após pausa (~600ms) e on-blur, com indicador “A guardar/Guardado/Não foi possível guardar”, versão e retry. Não avançar silenciosamente se a gravação falha. Retomar a partir do estado no servidor, também noutro dispositivo. Navegar para trás preserva dados.

Ativação mostra cada bloqueio e ligação para corrigir: dados, canal, agenda, subscrição e testes. Provisioning não depende de polling infinito: estado persistido, retry limitado e ação de retomar.

## Fluxos críticos

**Inbox:** desktop lista/conversa/painel de cliente; mobile lista → conversa → detalhe. Contagem de não lidas por utilizador. Badge explícita “IA ativa/A aguardar equipa/Em atendimento humano/IA pausada”. Botão Assumir pede transição ao backend; editor humano só envia com autorização confirmada. Reativar IA informa o efeito. WebSocket reconecta, mostra ligação perdida e recupera por cursor.

**Agenda:** dia/semana/lista, filtro de funcionário, timezone sempre visível, lookup cliente e serviço. Slot selecionado é proposta; conflito 409 mantém formulário e mostra alternativas atualizadas. Remarcação confirma nova data e só remove ocupação anterior após sucesso atómico. Cancelamento com motivo e confirmação; evitar duplicar POST no duplo clique.

**Plano:** uso com denominador e período, warnings 80/90/100%, descrição clara de excedentes, portal e subscrição. Estado “pagamento a confirmar” após Checkout até webhook; não mostrar ativo só pelo redirect.

**Dashboard:** zero verdadeiro é diferente de dado indisponível; empty state orienta próximo passo. Mostrar timezone/período, dados atualizados em, contagens e definições. Custo interno de providers limitado a permissões administrativas; não confundir com valor faturado ao cliente.

## Estados obrigatórios por ecrã

Loading com skeleton adequado; vazio com ação útil; erro recuperável com retry; sem permissão; offline/ligação perdida; sucesso; conflito de versão; dirty state; limite do plano. Preservar input após erro. Ações destrutivas têm confirmação específica com nome da entidade. Toast não pode ser a única fonte de erro acessível.

## Internacionalização e testes

ARB e localization oficial para pt/en/es/fr/de/it desde o shell inicial; revisão linguística antes do lançamento. Nada de textos de UI hardcoded. ISO currency e timezone IANA não inferidos da língua. Testar formatos e pluralização, textos longos, teclado, foco e layout a 360/768/1440 px; widget tests de forms, error/loading e auth; integration tests dos fluxos com API real.
