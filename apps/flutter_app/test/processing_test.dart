import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/conversations/processing_page.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

http.Response json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});
http.Response page(String? id, [String? next]) => json({'items': id == null ? [] : [{'id': id, 'state': 'failed', 'attempts': 5, 'nextAttemptAt': null}], 'next': next});
IdentityApi client(Future<http.Response> Function(http.Request) route) => IdentityApi(client: MockClient((r) async {
  if (r.url.path.endsWith('/csrf')) return json({'csrf_token': 'csrf'});
  if (r.url.path.endsWith('/refresh')) return json({'access_token': 'access', 'csrf_token': 'csrf'});
  return route(r);
}));
Widget screen(IdentityApi api, [String tenant = 'A']) => MaterialApp(locale: const Locale('pt'), localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales, home: ProcessingPage(tenantId: tenant, api: api));

void main() {
  testWidgets('filter and pagination use GET only; access failure clears rows', (tester) async {
    var fail = false;
    final api = client((r) async {
      expect(r.method, 'GET');
      if (fail) return json({}, 403);
      if (r.url.queryParameters['state'] != 'failed') return page(null);
      return r.url.queryParameters.containsKey('after') ? page('second') : page('first', 'cursor');
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pumpAndSettle();
    expect(find.text('Sem mensagens neste estado.'), findsOneWidget);
    await tester.tap(find.widgetWithText(ChoiceChip, 'Falhadas')); await tester.pumpAndSettle();
    expect(find.text('first'), findsOneWidget);
    await tester.ensureVisible(find.text('Carregar mais'));
    await tester.tap(find.text('Carregar mais')); await tester.pumpAndSettle();
    expect(find.text('second'), findsOneWidget);
    fail = true;
    await tester.tap(find.byIcon(Icons.refresh)); await tester.pumpAndSettle();
    expect(find.text('first'), findsNothing); expect(find.text('second'), findsNothing);
  });
  testWidgets('late tenant response is discarded on mobile', (tester) async {
    tester.view.physicalSize = const Size(390, 844); tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize); addTearDown(tester.view.resetDevicePixelRatio);
    final delayed = Completer<http.Response>();
    final api = client((r) async => r.url.path.contains('/A/') ? delayed.future : page('tenant B'));
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pump(); await tester.pump();
    await tester.pumpWidget(screen(api, 'B')); await tester.pumpAndSettle();
    delayed.complete(page('tenant A')); await tester.pumpAndSettle();
    expect(find.text('tenant A'), findsNothing); expect(find.text('tenant B'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
