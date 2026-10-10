import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/conversations/conversation_tags.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

void main() {
  testWidgets('tag catalog and assignment never submit customer messages', (tester) async {
    final names = <String, String>{'tag-1': 'Urgente'};
    final applied = <String>{};
    var sends = 0;
    var changes = 0;
    final api = IdentityApi(client: MockClient((request) async {
      if (request.url.path.endsWith('/auth/csrf')) {
        return http.Response('{"csrf_token":"csrf"}', 200);
      }
      if (request.url.path.endsWith('/auth/refresh')) {
        return http.Response('{"access_token":"access","csrf_token":"csrf"}', 200);
      }
      if (request.url.path.endsWith('/messages') && request.method == 'POST') sends++;
      if (request.url.path.endsWith('/conversation-tags') && request.method == 'POST') {
        final name = (jsonDecode(request.body) as Map<String, dynamic>)['name'];
        names['tag-2'] = name as String;
        return http.Response(jsonEncode({
          'item': {'id': 'tag-2', 'name': name}, 'duplicate': false,
        }), 200);
      }
      if (request.url.path.endsWith('/tags') && request.method == 'GET') {
        return http.Response(jsonEncode({
          'available': [
            for (final tag in names.entries) {'id': tag.key, 'name': tag.value},
          ],
          'applied': applied.toList(),
        }), 200);
      }
      if (request.url.path.endsWith('/tags/tag-1')) {
        changes++;
        if (request.method == 'POST') {
          applied.add('tag-1');
        } else {
          applied.remove('tag-1');
        }
        return http.Response(jsonEncode({
          'attached': request.method == 'POST', 'duplicate': false,
        }), 200);
      }
      return http.Response('{}', 404);
    }));
    addTearDown(api.dispose);
    await tester.pumpWidget(MaterialApp(
      locale: const Locale('pt'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(body: SingleChildScrollView(child: ConversationTags(
        tenantId: 'tenant-A', conversationId: 'conv-1', api: api,
      ))),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Urgente'), findsOneWidget);
    await tester.tap(find.text('Urgente'));
    await tester.pumpAndSettle();
    expect(changes, 1);
    expect(applied, contains('tag-1'));
    await tester.tap(find.text('Urgente'));
    await tester.pumpAndSettle();
    expect(changes, 2);
    expect(applied, isEmpty);
    await tester.enterText(find.byKey(const Key('inbox-tag-name')), 'Revisão');
    await tester.tap(find.byTooltip('Criar etiqueta'));
    await tester.pumpAndSettle();
    expect(find.text('Revisão'), findsOneWidget);
    expect(sends, 0);
    expect(tester.takeException(), isNull);
  });
}
