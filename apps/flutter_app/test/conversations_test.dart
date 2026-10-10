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
