import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/conversations/outbound_page.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

http.Response json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});
IdentityApi client(Future<http.Response> Function(http.Request) handler) => IdentityApi(client: MockClient((r) async {
  if (r.url.path.endsWith('/csrf')) return json({'csrf_token': 'csrf'});
  if (r.url.path.endsWith('/refresh')) return json({'access_token': 'access', 'csrf_token': 'csrf'});
  return handler(r);
}));
Widget screen(IdentityApi api, [String tenant = 'A']) => MaterialApp(locale: const Locale('pt'), localizationsDelegates: AppLocalizations.localizationsDelegates, supportedLocales: AppLocalizations.supportedLocales, home: OutboundPage(tenantId: tenant, conversationId: 'conversation', channelId: 'channel', api: api));
http.Response channels([String mode = 'mock']) => json([{'id': 'channel', 'mode': mode, 'status': 'active', 'channelType': 'whatsapp'}]);
Future<void> store(WidgetTester tester) async {
  await tester.enterText(find.byType(TextField), 'Olá teste');
  await tester.ensureVisible(find.text('Guardar intenção'));
  await tester.tap(find.text('Guardar intenção')); await tester.pumpAndSettle();
}

void main() {
  testWidgets('uncertain replay preserves payload and receipt uses GET only', (tester) async {
    final bodies = <String>[];
    var reads = 0;
    final api = client((r) async {
      if (r.url.path.endsWith('/channels')) return channels();
      if (r.method == 'POST') {
        bodies.add(r.body);
        if (bodies.length == 1) throw http.ClientException('lost response');
        return json({'intentId': 'receipt', 'state': 'pending', 'duplicate': true});
      }
      reads++;
      return json({'intentId': 'receipt', 'state': 'mock_accepted'});
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pumpAndSettle();
    await store(tester);
    expect(find.byType(TextField), findsNothing);
    await tester.tap(find.text('Repetir a mesma tentativa')); await tester.pumpAndSettle();
    expect(bodies.length, 2); expect(bodies[0], bodies[1]);
    expect(find.text('Intenção em processamento na fila de teste.'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1)); await tester.pumpAndSettle();
    expect(reads, 1); expect(bodies.length, 2);
    expect(find.text('Simulação aceite. Nenhuma mensagem WhatsApp foi enviada.'), findsOneWidget);
  });
  testWidgets('429 delays retry without changing the request key', (tester) async {
    final bodies = <String>[];
    final api = client((r) async {
      if (r.url.path.endsWith('/channels')) return channels();
      if (r.method == 'GET') return json({'intentId': 'receipt', 'state': 'mock_accepted'});
      bodies.add(r.body);
      if (bodies.length == 1) return http.Response('{}', 429, headers: {'retry-after': '2'});
      return json({'intentId': 'receipt', 'state': 'pending', 'duplicate': false});
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pumpAndSettle(); await store(tester);
    final retry = find.widgetWithText(FilledButton, 'Repetir a mesma tentativa');
    expect(tester.widget<FilledButton>(retry).onPressed, isNull);
    await tester.pump(const Duration(seconds: 3)); await tester.pumpAndSettle();
    await tester.tap(retry); await tester.pumpAndSettle();
    expect(bodies.length, 2); expect(bodies[0], bodies[1]);
  });
  testWidgets('live channel cannot expose a storage form', (tester) async {
    final api = client((_) async => channels('live')); addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pumpAndSettle();
    expect(find.byType(TextField), findsNothing);
    expect(find.text('Guardar intenção'), findsNothing);
  });
  testWidgets('late response cannot expose old tenant receipt', (tester) async {
    final late = Completer<http.Response>();
    final api = client((r) async {
      if (r.url.path.endsWith('/channels')) return channels();
      return late.future;
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Old secret');
    await tester.tap(find.text('Guardar intenção')); await tester.pump();
    await tester.pumpWidget(screen(api, 'B')); await tester.pumpAndSettle();
    late.complete(json({'intentId': 'old-receipt', 'state': 'stored'})); await tester.pumpAndSettle();
    expect(find.text('old-receipt'), findsNothing); expect(find.text('Old secret'), findsNothing);
    expect(find.text('Guardar intenção'), findsOneWidget);
  });
  testWidgets('automatic polling is bounded and never repeats POST', (tester) async {
    var posts = 0, reads = 0;
    final api = client((r) async {
      if (r.url.path.endsWith('/channels')) return channels();
      if (r.method == 'POST') {
        posts++;
        return json({'intentId': 'receipt', 'state': 'pending', 'duplicate': false});
      }
      reads++;
      return json({'intentId': 'receipt', 'state': 'pending'});
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Olá teste');
    await tester.tap(find.text('Guardar intenção')); await tester.pump();
    for (var i = 0; i < 20; i++) await tester.pump(const Duration(seconds: 1));
    expect(posts, 1); expect(reads, 15);
    expect(find.text('Consultar resultado'), findsOneWidget);
  });
}
