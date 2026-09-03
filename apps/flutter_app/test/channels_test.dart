import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/channels/channels_page.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

http.Response json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});
Map<String, String> channel(String name, [String mode = 'mock', String status = 'active']) => {'id': name, 'displayName': name, 'mode': mode, 'status': status};
IdentityApi client(Future<http.Response> Function(http.Request) route) => IdentityApi(client: MockClient((r) async {
  if (r.url.path.endsWith('/csrf')) return json({'csrf_token': 'csrf'});
  if (r.url.path.endsWith('/refresh')) return json({'access_token': 'access', 'csrf_token': 'csrf'});
  return route(r);
}));
Widget screen(IdentityApi api, [String tenant = 'A']) => MaterialApp(locale: const Locale('pt'),
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales, home: ChannelsPage(tenantId: tenant, api: api));

void main() {
  testWidgets('create validates name and disconnect requires confirmation', (tester) async {
    final rows = <Map<String, String>>[];
    final posts = <String>[];
    final api = client((r) async {
      if (r.method == 'GET') return json(rows);
      posts.add(r.url.path);
      if (r.url.path.endsWith('/mock')) {
        expect(jsonDecode(r.body), {'displayName': 'Teste'});
        rows.add(channel('Teste'));
        return json(rows.last, 201);
      }
      rows[0] = channel('Teste', 'mock', 'disconnected');
      return json(rows[0]);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pumpAndSettle();
    await tester.tap(find.text('Criar canal de teste')); await tester.pumpAndSettle();
    expect(posts, isEmpty);
    await tester.enterText(find.byType(TextFormField), '  Teste  ');
    await tester.tap(find.text('Criar canal de teste')); await tester.pumpAndSettle();
    expect(posts.length, 1);
    expect(find.text('Teste'), findsOneWidget);
    await tester.ensureVisible(find.text('Desligar canal'));
    await tester.tap(find.text('Desligar canal')); await tester.pumpAndSettle();
    await tester.tap(find.text('Fechar')); await tester.pumpAndSettle();
    expect(posts.length, 1);
    await tester.ensureVisible(find.text('Desligar canal'));
    await tester.tap(find.text('Desligar canal')); await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Desligar canal')); await tester.pumpAndSettle();
    expect(posts.length, 2);
    expect(find.text('Desligado'), findsOneWidget);
  });
  testWidgets('denied access hides actions and ambiguous mutation is not retried', (tester) async {
    var denied = true;
    var posts = 0;
    final api = client((r) async {
      if (r.method == 'POST') { posts++; throw http.ClientException('network'); }
      return denied ? json({}, 403) : json([]);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pumpAndSettle();
    expect(find.byType(TextFormField), findsNothing);
    denied = false;
    await tester.tap(find.byIcon(Icons.refresh)); await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField), 'Teste');
    await tester.tap(find.text('Criar canal de teste')); await tester.pumpAndSettle();
    expect(posts, 1);
    expect(find.textContaining('Não foi possível confirmar a operação.'), findsOneWidget);
    expect(find.byType(TextFormField), findsNothing);
  });
  testWidgets('mobile live channel is read only and late tenant response is ignored', (tester) async {
    tester.view.physicalSize = const Size(390, 844); tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize); addTearDown(tester.view.resetDevicePixelRatio);
    final delayed = Completer<http.Response>();
    final api = client((r) async => r.url.path.contains('/A/') ? delayed.future : json([channel('Empresa B', 'live')]));
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pump(); await tester.pump();
    await tester.pumpWidget(screen(api, 'B')); await tester.pumpAndSettle();
    delayed.complete(json([channel('Empresa A')])); await tester.pumpAndSettle();
    expect(find.text('Empresa A'), findsNothing);
    expect(find.text('Empresa B'), findsOneWidget);
    expect(find.text('Desligar canal'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
