import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/conversations/conversations_page.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

Widget screen(IdentityApi api) => MaterialApp(locale: const Locale('pt'), localizationsDelegates: AppLocalizations.localizationsDelegates, supportedLocales: AppLocalizations.supportedLocales, home: ConversationsPage(tenantId: 'tenant', api: api, realtimeEnabled: false));
http.Response page(List<Object> items, [String? next]) => http.Response(jsonEncode({'items': items, 'next': next}), 200, headers: {'content-type': 'application/json; charset=utf-8'});
Map<String, Object> conversation(String id) => {'id': id, 'customer': {'displayName': 'Cliente $id'}, 'channelConnection': {'displayName': 'Sandbox', 'mode': 'mock'}};
Map<String, Object> message(String text) => {'contentText': text, 'direction': 'inbound', 'createdAt': '2026-09-02T12:00:00Z'};
IdentityApi client(Future<http.Response> Function(http.Request) route) => IdentityApi(client: MockClient((request) async {
  if (request.url.path.endsWith('/csrf')) return http.Response('{"csrf_token":"csrf"}', 200);
  if (request.url.path.endsWith('/refresh')) return http.Response('{"access_token":"access","csrf_token":"csrf"}', 200);
  if (request.method == 'GET' && request.url.path.endsWith('/internal-notes')) return page([]);
  return route(request);
}));

void main() {
  testWidgets('unread summary counts only loaded and filtered rows', (tester) async {
    tester.view.physicalSize = const Size(1100, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = client((r) async {
      if (r.url.path.endsWith('/inbox/unread-summary')) {
        return http.Response(jsonEncode({
          'unreadConversations': 7, 'unreadMessages': 16,
        }), 200);
      }
      if (r.url.path.endsWith('/conversations')) {
        if (r.url.queryParameters['q'] == 'special') {
          return page([{...conversation('filtered'), 'unreadCount': 4}]);
        }
        return page([
          {...conversation('first'), 'unreadCount': 2},
          {...conversation('second'), 'unreadCount': 0},
        ], 'next-page');
      }
      return page([]);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api));
    await tester.pumpAndSettle();
    expect(find.text('Nesta lista — conversas por ler: 1; mensagens por ler: 2'), findsOneWidget);
    expect(find.text('No tenant — conversas por ler: 7; mensagens por ler: 16'), findsOneWidget);
    await tester.enterText(find.byType(TextField).first, 'special');
    await tester.tap(find.text('Pesquisar'));
    await tester.pumpAndSettle();
    expect(find.text('Nesta lista — conversas por ler: 1; mensagens por ler: 4'), findsOneWidget);
    expect(find.text('Nesta lista — conversas por ler: 1; mensagens por ler: 2'), findsNothing);
    // Tenant total is unaffected by pagination or the local search filter.
    expect(find.text('No tenant — conversas por ler: 7; mensagens por ler: 16'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets('late summary from previous tenant cannot overwrite current totals', (tester) async {
    tester.view.physicalSize = const Size(1100, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final oldReply = Completer<http.Response>();
    final api = client((request) async {
      if (request.url.path.endsWith('/inbox/unread-summary')) {
        if (request.url.path.contains('/tenant-1/')) return oldReply.future;
        return http.Response(jsonEncode({
          'unreadConversations': 2, 'unreadMessages': 3,
        }), 200);
      }
      if (request.url.path.endsWith('/conversations')) {
        return page([conversation(request.url.path.contains('/tenant-1/') ? 'A' : 'B')]);
      }
      return page([]);
    });
    addTearDown(api.dispose);
    Widget forTenant(String id) => MaterialApp(
      locale: const Locale('pt'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: ConversationsPage(tenantId: id, api: api, realtimeEnabled: false),
    );
    await tester.pumpWidget(forTenant('tenant-1'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('inbox-unread-tenant-summary')), findsNothing);
    await tester.pumpWidget(forTenant('tenant-2'));
    await tester.pumpAndSettle();
    expect(find.text('Cliente A'), findsNothing);
    expect(find.text('No tenant — conversas por ler: 2; mensagens por ler: 3'), findsOneWidget);
    oldReply.complete(http.Response(jsonEncode({
      'unreadConversations': 99, 'unreadMessages': 999,
    }), 200));
    await tester.pumpAndSettle();
    expect(find.text('No tenant — conversas por ler: 2; mensagens por ler: 3'), findsOneWidget);
    expect(find.textContaining('999'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('search retains query on pagination and discards late results', (tester) async {
    final late = Completer<http.Response>();
    final api = client((r) async {
      final query = r.url.queryParameters['q'];
      if (query == 'old') return late.future;
      if (query == 'A & B') {
        return r.url.queryParameters['after'] == 'cursor' ? page([conversation('second')]) : page([conversation('first')], 'cursor');
      }
      expect(r.url.queryParameters.containsKey('after'), false);
      return page([]);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'old');
    await tester.tap(find.text('Pesquisar')); await tester.pump();
    await tester.enterText(find.byType(TextField), 'A & B');
    await tester.tap(find.text('Pesquisar')); await tester.pumpAndSettle();
    late.complete(page([conversation('old')])); await tester.pumpAndSettle();
    expect(find.text('Cliente old'), findsNothing);
    expect(find.text('Cliente first'), findsOneWidget);
    await tester.ensureVisible(find.text('Carregar mais'));
    await tester.tap(find.text('Carregar mais')); await tester.pumpAndSettle();
    expect(find.text('Cliente second'), findsOneWidget);
    await tester.tap(find.byIcon(Icons.clear)); await tester.pumpAndSettle();
    expect(find.text('Ainda não existem conversas.'), findsOneWidget);
  });
  testWidgets('tag filter combines with search and survives pagination', (tester) async {
    tester.view.physicalSize = const Size(1100, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final paths = <Uri>[];
    final api = client((r) async {
      if (r.url.path.endsWith('/conversation-tags')) {
        return http.Response(jsonEncode({'items': [
          {'id': 'tag-1', 'name': 'Urgente'},
        ]}), 200);
      }
      if (r.url.path.endsWith('/conversations')) {
        paths.add(r.url);
        if (r.url.queryParameters['tagId'] == 'tag-1') {
          if (r.url.queryParameters['after'] == 'cursor') {
            return page([conversation('second')]);
          }
          return page([conversation('first')], 'cursor');
        }
        return page([conversation('other')]);
      }
      return page([]);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api));
    await tester.pumpAndSettle();
    expect(find.text('Cliente other'), findsOneWidget);
    await tester.tap(find.byKey(const Key('inbox-filter-tags')));
    await tester.pumpAndSettle();
    expect(find.text('Urgente'), findsOneWidget);
    await tester.tap(find.byKey(const Key('inbox-filter-tag-1')));
    await tester.pumpAndSettle();
    expect(paths.last.queryParameters['tagId'], 'tag-1');
    expect(find.text('Cliente first'), findsOneWidget);
    await tester.enterText(find.byType(TextField).first, 'A & B');
    await tester.tap(find.text('Pesquisar'));
    await tester.pumpAndSettle();
    expect(paths.last.queryParameters['q'], 'A & B');
    expect(paths.last.queryParameters['tagId'], 'tag-1');
    await tester.ensureVisible(find.text('Carregar mais'));
    await tester.tap(find.text('Carregar mais'));
    await tester.pumpAndSettle();
    expect(paths.last.queryParameters['after'], 'cursor');
    expect(paths.last.queryParameters['tagId'], 'tag-1');
    expect(paths.last.queryParameters['q'], 'A & B');
    await tester.tap(find.byKey(const Key('inbox-filter-all')));
    await tester.pumpAndSettle();
    expect(paths.last.queryParameters.containsKey('after'), false);
    expect(paths.last.queryParameters.containsKey('tagId'), false);
    expect(find.text('Cliente other'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('unread-only filter keeps search, tag, and cursor and resets on toggle', (tester) async {
    tester.view.physicalSize = const Size(1100, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final requests = <Uri>[];
    final api = client((r) async {
      if (r.url.path.endsWith('/conversation-tags')) {
        return http.Response(jsonEncode({'items': [
          {'id': 'tag-1', 'name': 'Urgente'},
        ]}), 200);
      }
      if (r.url.path.endsWith('/conversations')) {
        requests.add(r.url);
        if (r.url.queryParameters['unreadOnly'] == 'true') {
          if (r.url.queryParameters['after'] == 'cursor') {
            return page([conversation('segunda')]);
          }
          return page([conversation('primeira')], 'cursor');
        }
        return page([conversation('todas')]);
      }
      return page([]);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api));
    await tester.pumpAndSettle();
    expect(find.text('Cliente todas'), findsOneWidget);

    await tester.tap(find.byKey(const Key('inbox-filter-unread')));
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters['unreadOnly'], 'true');
    expect(find.text('Cliente primeira'), findsOneWidget);
    await tester.tap(find.byKey(const Key('inbox-filter-tags')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('inbox-filter-tag-1')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'A & B');
    await tester.tap(find.text('Pesquisar'));
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters['unreadOnly'], 'true');
    expect(requests.last.queryParameters['tagId'], 'tag-1');
    expect(requests.last.queryParameters['q'], 'A & B');
    await tester.ensureVisible(find.text('Carregar mais'));
    await tester.tap(find.text('Carregar mais'));
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters['after'], 'cursor');
    expect(requests.last.queryParameters['unreadOnly'], 'true');
    expect(requests.last.queryParameters['tagId'], 'tag-1');
    expect(requests.last.queryParameters['q'], 'A & B');

    await tester.tap(find.byKey(const Key('inbox-filter-unread')));
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters.containsKey('unreadOnly'), false);
    expect(requests.last.queryParameters.containsKey('after'), false);
    expect(requests.last.queryParameters['tagId'], 'tag-1');
    expect(requests.last.queryParameters['q'], 'A & B');
    expect(find.text('Cliente todas'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('channel mode combines with filters, paginates and resets cursor', (tester) async {
    tester.view.physicalSize = const Size(1100, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final requests = <Uri>[];
    final api = client((request) async {
      if (request.url.path.endsWith('/conversations')) {
        requests.add(request.url);
        if (request.url.queryParameters['channelMode'] == 'mock') {
          return request.url.queryParameters['after'] == 'cursor'
              ? page([conversation('mock-second')])
              : page([conversation('mock-first')], 'cursor');
        }
        return page([conversation('live')]);
      }
      return page([]);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('inbox-filter-channel-mode')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Simulados').last);
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters['channelMode'], 'mock');
    expect(requests.last.queryParameters.containsKey('after'), false);
    expect(find.text('Cliente mock-first'), findsOneWidget);
    await tester.tap(find.byKey(const Key('inbox-filter-status')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Encerradas').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('inbox-filter-unread')));
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters['status'], 'closed');
    expect(requests.last.queryParameters['unreadOnly'], 'true');
    expect(requests.last.queryParameters['channelMode'], 'mock');
    await tester.ensureVisible(find.text('Carregar mais'));
    await tester.tap(find.text('Carregar mais'));
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters['after'], 'cursor');
    expect(requests.last.queryParameters['channelMode'], 'mock');
    await tester.tap(find.byKey(const Key('inbox-filter-channel-mode')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Ao vivo').last);
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters['channelMode'], 'live');
    expect(requests.last.queryParameters.containsKey('after'), false);
    expect(requests.last.queryParameters['status'], 'closed');
    expect(requests.last.queryParameters['unreadOnly'], 'true');
    expect(find.text('Cliente live'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets('lifecycle filter combines with assignment and retains paged cursors', (tester) async {
    tester.view.physicalSize = const Size(1100, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final requests = <Uri>[];
    final api = client((request) async {
      if (request.url.path.endsWith('/conversations')) {
        requests.add(request.url);
        if (request.url.queryParameters['status'] == 'closed') {
          return request.url.queryParameters['after'] == 'cursor'
              ? page([conversation('second')])
              : page([conversation('first')], 'cursor');
        }
        return page([conversation('all')]);
      }
      return page([]);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api));
    await tester.pumpAndSettle();
    expect(find.text('Cliente all'), findsOneWidget);
    await tester.tap(find.byKey(const Key('inbox-filter-status')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Encerradas').last);
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters['status'], 'closed');
    expect(requests.last.queryParameters.containsKey('after'), false);
    expect(find.text('Cliente first'), findsOneWidget);
    await tester.tap(find.byKey(const Key('inbox-filter-assignment')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Atribuídas a mim').last);
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters['status'], 'closed');
    expect(requests.last.queryParameters['assignment'], 'mine');
    await tester.ensureVisible(find.text('Carregar mais'));
    await tester.tap(find.text('Carregar mais'));
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters['after'], 'cursor');
    expect(requests.last.queryParameters['status'], 'closed');
    expect(requests.last.queryParameters['assignment'], 'mine');
    expect(find.text('Cliente second'), findsOneWidget);
    await tester.tap(find.byKey(const Key('inbox-filter-status')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Abertas').last);
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters['status'], 'open');
    expect(requests.last.queryParameters['assignment'], 'mine');
    expect(requests.last.queryParameters.containsKey('after'), false);
    expect(find.text('Cliente all'), findsOneWidget);
    await tester.tap(find.byKey(const Key('inbox-filter-status')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Todos os estados').last);
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters.containsKey('status'), false);
    expect(tester.takeException(), isNull);
  });

  testWidgets('assignment filter composes with unread and resets pagination', (tester) async {
    tester.view.physicalSize = const Size(1100, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final requests = <Uri>[];
    final api = client((request) async {
      if (request.url.path.endsWith('/conversations')) {
        requests.add(request.url);
        return page([conversation('A')]);
      }
      return page([]);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('inbox-filter-unread')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('inbox-filter-assignment')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Atribuídas a mim').last);
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters['assignment'], 'mine');
    expect(requests.last.queryParameters['unreadOnly'], 'true');
    expect(requests.last.queryParameters.containsKey('after'), false);
    await tester.tap(find.byKey(const Key('inbox-filter-assignment')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sem atribuição').last);
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters['assignment'], 'unassigned');
    await tester.tap(find.byKey(const Key('inbox-filter-assignment')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Todas as atribuições').last);
    await tester.pumpAndSettle();
    expect(requests.last.queryParameters.containsKey('assignment'), false);
    expect(tester.takeException(), isNull);
  });

  testWidgets('empty conversations and failed refresh offer recovery', (tester) async {
    var fail = true;
    final api = client((_) async => fail ? http.Response('{}', 403) : page([]));
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api));
    await tester.pumpAndSettle();
    expect(find.text('Ainda não existem conversas.'), findsNothing);
    expect(find.text('Não foi possível concluir. Verifica a ligação e as permissões e tenta novamente.'), findsOneWidget);
    fail = false;
    await tester.tap(find.text('Atualizar'));
    await tester.pumpAndSettle();
    expect(find.text('Ainda não existem conversas.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('mobile history reads pages without a send control', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = client((r) async {
      if (!r.url.path.endsWith('/messages')) return page([conversation('A')]);
      return r.url.queryParameters['after'] == 'next' ? page([message('Segunda')]) : page([message('Primeira')], 'next');
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cliente A'));
    await tester.pumpAndSettle();
    expect(find.text('Primeira'), findsOneWidget);
    // The new text field is a private internal-note composer, not a customer send control.
    expect(find.byKey(const Key('inbox-internal-note-compose')), findsOneWidget);
    await tester.tap(find.text('Carregar mais'));
    await tester.pumpAndSettle();
    expect(find.text('Primeira'), findsOneWidget);
    expect(find.text('Segunda'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('unread badge requires an explicit read acknowledgement', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final acks = <Map<String, dynamic>>[];
    final marked = <String, Object?>{
      ...conversation('A'),
      'unreadCount': 2,
      'unreadUpTo': '4',
    };
    final api = client((request) async {
      if (request.url.path.endsWith('/A/read')) {
        acks.add(jsonDecode(request.body) as Map<String, dynamic>);
        return http.Response('{"unreadUpTo":"4","duplicate":false}', 200);
      }
      if (request.url.path.endsWith('/A/messages')) return page([message('Primeira')]);
      return page([marked]);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.mark_chat_unread_outlined), findsOneWidget);
    expect(acks, isEmpty);
    await tester.tap(find.text('Cliente A'));
    await tester.pumpAndSettle();
    expect(acks, isEmpty); // Opening a paginated history never silently marks read.
    expect(find.text('Marcar como lida'), findsOneWidget);
    await tester.tap(find.text('Marcar como lida'));
    await tester.pumpAndSettle();
    expect(acks, [{'upTo': '4'}]);
    expect(find.text('Marcar como lida'), findsNothing);
    expect(find.text('Primeira'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('late response cannot overwrite the newly selected conversation', (tester) async {
    final delayed = Completer<http.Response>();
    final api = client((r) async {
      if (r.url.path.contains('/A/messages')) return delayed.future;
      if (r.url.path.contains('/B/messages')) return page([message('Mensagem B')]);
      return page([conversation('A'), conversation('B')]);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cliente A'));
    await tester.pump();
    await tester.tap(find.text('Cliente B'));
    await tester.pumpAndSettle();
    delayed.complete(page([message('Mensagem A') ]));
    await tester.pumpAndSettle();
    expect(find.text('Mensagem B'), findsOneWidget);
    expect(find.text('Mensagem A'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
