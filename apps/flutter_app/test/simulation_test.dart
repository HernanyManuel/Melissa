import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/channels/simulation_page.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

http.Response json(Object body, [int code = 200]) => http.Response(jsonEncode(body), code, headers: {'content-type': 'application/json; charset=utf-8'});
IdentityApi client(Future<http.Response> Function(http.Request) route) => IdentityApi(client: MockClient((r) async {
  if (r.url.path.endsWith('/csrf')) return json({'csrf_token': 'csrf'});
  if (r.url.path.endsWith('/refresh')) return json({'access_token': 'access', 'csrf_token': 'csrf'});
  return route(r);
}));
Widget screen(IdentityApi api, [String tenant = 'A']) => MaterialApp(locale: const Locale('pt'),
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: SimulationPage(tenantId: tenant, channelId: 'channel', api: api));
http.Response channels([String mode = 'mock']) => json([{'id': 'channel', 'mode': mode, 'status': 'active'}]);
http.Response customers(String name) => json({'items': [{'id': name, 'displayName': name}], 'next': null});

Future<void> fill(WidgetTester tester) async {
  await tester.tap(find.byType(DropdownButtonFormField<String>)); await tester.pumpAndSettle();
  await tester.tap(find.text('Cliente').last); await tester.pumpAndSettle();
  await tester.enterText(find.widgetWithText(TextFormField, 'Mensagem de teste'), 'Olá');
  await tester.ensureVisible(find.text('Simular entrada'));
  await tester.tap(find.text('Simular entrada')); await tester.pumpAndSettle();
}

void main() {
  test('simulation UUID is version 4 with variant bits', () {
    final ids = List.generate(100, (_) => simulationId());
    expect(ids.toSet().length, 100);
    for (final id in ids) { expect(id, matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))); }
  });
  testWidgets('uncertain POST retries exact payload and checks receipt without resending', (tester) async {
    final bodies = <String>[];
    final api = client((r) async {
      if (r.url.path.endsWith('/channels')) return channels();
      if (r.url.path.endsWith('/customers')) return customers('Cliente');
      if (r.method == 'POST') {
        bodies.add(r.body);
        if (bodies.length == 1) throw http.ClientException('lost response');
        return json({'eventId': 'receipt', 'duplicate': true}, 202);
      }
      return json({'state': 'processed', 'message': {'id': 'message'}});
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pumpAndSettle();
    await fill(tester);
    expect(find.textContaining('Receção não confirmada.'), findsOneWidget);
    expect(find.byType(TextFormField), findsNothing);
    await tester.tap(find.text('Repetir a mesma tentativa')); await tester.pumpAndSettle();
    expect(bodies.length, 2); expect(bodies[0], bodies[1]);
    expect(find.text('Aceite na fila; aguarda processamento.'), findsOneWidget);
    await tester.tap(find.text('Consultar resultado')); await tester.pumpAndSettle();
    expect(bodies.length, 2);
    expect(find.textContaining('Processada e guardada'), findsOneWidget);
    expect(find.text('Nova simulação'), findsOneWidget);
  });
  testWidgets('live channel cannot show simulation form', (tester) async {
    var customerRequests = 0;
    final api = client((r) async {
      if (r.url.path.endsWith('/channels')) return channels('live');
      customerRequests++; return customers('Cliente');
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pumpAndSettle();
    expect(find.text('Simular entrada'), findsNothing); expect(customerRequests, 0);
  });
  testWidgets('late customer response cannot cross tenant boundary on mobile', (tester) async {
    tester.view.physicalSize = const Size(390, 844); tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize); addTearDown(tester.view.resetDevicePixelRatio);
    final delayed = Completer<http.Response>();
    final api = client((r) async {
      if (r.url.path.endsWith('/channels')) return channels();
      return r.url.path.contains('/A/') ? delayed.future : customers('Empresa B');
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api)); await tester.pump(); await tester.pump();
    await tester.pumpWidget(screen(api, 'B')); await tester.pumpAndSettle();
    delayed.complete(customers('Empresa A')); await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButtonFormField<String>)); await tester.pumpAndSettle();
    expect(find.text('Empresa A'), findsNothing); expect(find.text('Empresa B'), findsWidgets);
    expect(tester.takeException(), isNull);
  });
}
