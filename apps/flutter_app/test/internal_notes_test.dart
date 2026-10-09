import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/conversations/internal_notes.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

void main() {
  testWidgets('note retry uses same key without sending a customer message', (tester) async {
    final attempts = <Map<String, dynamic>>[];
    var stored = false;
    var messagePosts = 0;
    final api = IdentityApi(client: MockClient((request) async {
      if (request.url.path.endsWith('/auth/csrf')) {
        return http.Response('{"csrf_token":"csrf"}', 200);
      }
      if (request.url.path.endsWith('/auth/refresh')) {
        return http.Response('{"access_token":"access","csrf_token":"csrf"}', 200);
      }
      if (request.url.path.endsWith('/messages') && request.method == 'POST') {
        messagePosts++;
      }
      if (request.url.path.endsWith('/internal-notes')) {
        if (request.method == 'GET') {
          return http.Response(jsonEncode({
            'items': stored ? [{
              'id': 'note-1',
              'text': 'Só para a equipa',
              'createdAt': '2026-10-09T16:00:00Z',
            }] : <Map<String, String>>[],
            'next': null,
          }), 200);
        }
        attempts.add(jsonDecode(request.body) as Map<String, dynamic>);
        stored = true;
        if (attempts.length == 1) return http.Response('{}', 503);
        return http.Response(jsonEncode({
          'item': {'id': 'note-1', 'text': attempts.last['text']},
          'duplicate': true,
        }), 200);
      }
      return http.Response('{}', 404);
    }));
    addTearDown(api.dispose);
    await tester.pumpWidget(MaterialApp(
      locale: const Locale('pt'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(body: SingleChildScrollView(child: ConversationInternalNotes(
        tenantId: 'tenant-A', conversationId: 'conv-1', api: api,
      ))),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Visíveis apenas à equipa. Não são enviadas ao cliente.'),
        findsOneWidget);
    await tester.enterText(
      find.byKey(const Key('inbox-internal-note-compose')), 'Só para a equipa');
    await tester.tap(find.text('Guardar nota'));
    await tester.pumpAndSettle();
    expect(find.text('Repetir a mesma nota'), findsOneWidget);
    expect(attempts.length, 1);
    expect(messagePosts, 0);
    await tester.tap(find.text('Repetir a mesma nota'));
    await tester.pumpAndSettle();
    expect(attempts.length, 2);
    expect(attempts.first, attempts.last);
    expect(find.text('Só para a equipa'), findsOneWidget);
    expect(find.text('Guardar nota'), findsOneWidget);
    expect(messagePosts, 0);
    expect(tester.takeException(), isNull);
  });
}
