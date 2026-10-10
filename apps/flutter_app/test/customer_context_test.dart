import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/conversations/customer_context.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

void main() {
  testWidgets('read-only customer context uses tenant-scoped GET', (tester) async {
    final requests = <String>[];
    final api = IdentityApi(client: MockClient((request) async {
      requests.add('${request.method} ${request.url.path}');
      if (request.url.path.endsWith('/auth/refresh')) {
        return http.Response('{"access_token":"access","csrf_token":"csrf"}', 200);
      }
      if (request.url.path.endsWith('/auth/csrf')) {
        return http.Response('{"csrf_token":"csrf"}', 200);
      }
      if (request.url.path.endsWith('/conversations/c1/customer')) {
        return http.Response(jsonEncode({'item': {
          'id': 'customer-1',
          'displayName': 'Ana',
          'phoneE164': '+351912345678',
          'email': 'ana@example.test',
          'language': 'pt',
          'whatsappOptInStatus': 'unknown',
          'notes': 'Prefere manhãs',
        }}), 200);
      }
      return http.Response('{}', 404);
    }));
    addTearDown(api.dispose);
    await tester.pumpWidget(MaterialApp(
      locale: const Locale('pt'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(body: ConversationCustomerContext(
        tenantId: 'tenant-1', conversationId: 'c1', api: api,
      )),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Perfil do cliente'), findsOneWidget);
    await tester.tap(find.text('Perfil do cliente'));
    await tester.pumpAndSettle();
    expect(find.text('Ana'), findsOneWidget);
    expect(find.text('Telefone: +351912345678'), findsOneWidget);
    expect(find.text('Notas do cliente: Prefere manhãs'), findsOneWidget);
    expect(requests.where((r) => r.endsWith('/conversations/c1/customer')).length, 1);
    expect(requests.where((r) => r.contains('/messages')).isEmpty, true);
    expect(tester.takeException(), isNull);
  });
}
