import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/conversations/conversations_page.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

Widget screen(IdentityApi api) => MaterialApp(locale: const Locale('pt'), localizationsDelegates: AppLocalizations.localizationsDelegates, supportedLocales: AppLocalizations.supportedLocales, home: ConversationsPage(tenantId: 'tenant', api: api));
http.Response page(List<Object> items, [String? next]) => http.Response(jsonEncode({'items': items, 'next': next}), 200, headers: {'content-type': 'application/json; charset=utf-8'});
Map<String, Object> conversation(String id) => {'id': id, 'customer': {'displayName': 'Cliente $id'}, 'channelConnection': {'displayName': 'Sandbox', 'mode': 'mock'}};
Map<String, Object> message(String text) => {'contentText': text, 'direction': 'inbound', 'createdAt': '2026-09-02T12:00:00Z'};
IdentityApi client(Future<http.Response> Function(http.Request) route) => IdentityApi(client: MockClient((request) async {
  if (request.url.path.endsWith('/csrf')) return http.Response('{"csrf_token":"csrf"}', 200);
  if (request.url.path.endsWith('/refresh')) return http.Response('{"access_token":"access","csrf_token":"csrf"}', 200);
  return route(request);
}));

void main() {
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
    expect(find.byType(TextField), findsNothing);
    await tester.tap(find.text('Carregar mais'));
    await tester.pumpAndSettle();
    expect(find.text('Primeira'), findsOneWidget);
    expect(find.text('Segunda'), findsOneWidget);
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
