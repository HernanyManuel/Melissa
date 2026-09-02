import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/customers/customers_page.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

void main() {
  for (final role in ['owner', 'staff']) {
    testWidgets('customers empty state respects $role permissions', (tester) async {
      final api = IdentityApi(client: MockClient((request) async {
        if (request.url.path.endsWith('/csrf')) return http.Response('{"csrf_token":"csrf"}', 200);
        if (request.url.path.endsWith('/refresh')) return http.Response('{"access_token":"access","csrf_token":"csrf"}', 200);
        if (request.url.path.endsWith('/tenants')) return http.Response(jsonEncode([{'role': role, 'tenant': {'id': 'tenant'}}]), 200);
        return http.Response('{"items":[],"next":null}', 200);
      }));
      addTearDown(api.dispose);
      await tester.pumpWidget(MaterialApp(locale: const Locale('pt'), localizationsDelegates: AppLocalizations.localizationsDelegates, supportedLocales: AppLocalizations.supportedLocales, home: CustomersPage(tenantId: 'tenant', api: api)));
      await tester.pumpAndSettle();
      expect(find.text('Ainda não existem clientes.'), findsOneWidget);
      expect(find.text('Novo cliente'), role == 'owner' ? findsOneWidget : findsNothing);
      expect(tester.takeException(), isNull);
    });
  }
  testWidgets('customer editor validates and preserves fields on duplicate', (tester) async {
    var writes = 0;
    final api = IdentityApi(client: MockClient((request) async {
      writes++;
      expect(jsonDecode(request.body)['phoneE164'], '+351912345678');
      return http.Response('{}', 409);
    }));
    addTearDown(api.dispose);
    await tester.pumpWidget(MaterialApp(locale: const Locale('pt'), localizationsDelegates: AppLocalizations.localizationsDelegates, supportedLocales: AppLocalizations.supportedLocales, home: Scaffold(body: CustomerEditor(api: api, path: '/tenants/tenant/customers'))));
    await tester.tap(find.text('Guardar cliente'));
    await tester.pumpAndSettle();
    expect(writes, 0);
    await tester.enterText(find.byType(TextFormField).at(0), 'Cliente');
    await tester.enterText(find.byType(TextFormField).at(1), '+351912345678');
    await tester.tap(find.text('Guardar cliente'));
    await tester.pumpAndSettle();
    expect(writes, 1);
    expect(find.text('Este telefone já pertence a um cliente, incluindo clientes arquivados.'), findsOneWidget);
    expect(find.text('Cliente'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
