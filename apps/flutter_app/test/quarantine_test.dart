import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/quarantine/quarantine_page.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

Widget screen(IdentityApi api, [String tenant = 'A']) => MaterialApp(locale: const Locale('pt'),
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales, home: QuarantinePage(tenantId: tenant, api: api));
http.Response page(List<Object> items, [String? next]) => http.Response(jsonEncode({
  'items': items, 'next': next, 'total': items.length, 'expired': 0, 'expiringSoon': 0, 'capacity': 1000,
}), 200, headers: {'content-type': 'application/json; charset=utf-8'});
Map<String, Object> item(String name) => {'id': name, 'channelName': name,
  'createdAt': '2026-09-03T12:00:00Z', 'expiresAt': '2026-09-10T12:00:00Z', 'expired': false};
IdentityApi client(Future<http.Response> Function(http.Request) route) => IdentityApi(client: MockClient((r) async {
  if (r.url.path.endsWith('/csrf')) return http.Response('{"csrf_token":"csrf"}', 200);
  if (r.url.path.endsWith('/refresh')) return http.Response('{"access_token":"access","csrf_token":"csrf"}', 200);
  return route(r);
}));

void main() {
  testWidgets('quarantine recovers from denied access to empty state', (tester) async {
    var fail = true;
    final api = client((_) async => fail ? http.Response('{}', 403) : page([]));
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pumpAndSettle();
    expect(find.text('Não foi possível concluir. Verifica a ligação e as permissões e tenta novamente.'), findsOneWidget);
    fail = false;
    await tester.tap(find.widgetWithText(OutlinedButton, 'Atualizar'));
    await tester.pumpAndSettle();
    expect(find.text('Sem eventos em quarentena.'), findsOneWidget);
  });
  testWidgets('mobile quarantine pages metadata without editing controls', (tester) async {
    tester.view.physicalSize = const Size(390, 844); tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize); addTearDown(tester.view.resetDevicePixelRatio);
    final api = client((r) async => r.url.queryParameters.containsKey('after') ? page([item('Second')]) : page([item('First')], 'cursor'));
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Carregar mais'));
    await tester.tap(find.text('Carregar mais')); await tester.pumpAndSettle();
    expect(find.text('Second'), findsWidgets);
    expect(find.byType(TextField), findsNothing);
    expect(tester.takeException(), isNull);
  });
  testWidgets('late tenant response cannot reveal previous company metadata', (tester) async {
    final delayed = Completer<http.Response>();
    final api = client((r) async => r.url.path.contains('/A/') ? delayed.future : page([item('Company B')]));
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pump(); await tester.pump();
    await tester.pumpWidget(screen(api, 'B')); await tester.pumpAndSettle();
    delayed.complete(page([item('Company A')])); await tester.pumpAndSettle();
    expect(find.text('Company A'), findsNothing);
    expect(find.text('Company B'), findsWidgets);
    expect(tester.takeException(), isNull);
  });
}
