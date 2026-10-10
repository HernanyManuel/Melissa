import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/conversations/internal_notes.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

void main() {
  testWidgets('late note receipt cannot clear another conversation draft', (tester) async {
    final delayed = Completer<http.Response>();
    final posts = <String>[];
    final api = IdentityApi(client: MockClient((request) async {
      if (request.url.path.endsWith('/auth/csrf')) {
        return http.Response('{"csrf_token":"csrf"}', 200);
      }
      if (request.url.path.endsWith('/auth/refresh')) {
        return http.Response('{"access_token":"access","csrf_token":"csrf"}', 200);
      }
      if (request.url.path.endsWith('/internal-notes')) {
        if (request.method == 'GET') {
          return http.Response('{"items":[],"next":null}', 200);
        }
        posts.add(request.url.path);
        if (posts.length == 1) return delayed.future;
        return http.Response(jsonEncode({
          'item': {'id': 'note-b', 'text': 'Nova conversa'},
          'duplicate': false,
        }), 200);
      }
      return http.Response('{}', 404);
    }));
    addTearDown(api.dispose);

    Widget frame(String tenant, String conversation) => MaterialApp(
      locale: const Locale('pt'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(body: SingleChildScrollView(child: ConversationInternalNotes(
        tenantId: tenant, conversationId: conversation, api: api,
      ))),
    );

    await tester.pumpWidget(frame('tenant-A', 'conv-A'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('inbox-internal-note-compose')), 'Rascunho antigo');
    await tester.tap(find.text('Guardar nota'));
    await tester.pump();
    expect(posts.length, 1);

    await tester.pumpWidget(frame('tenant-B', 'conv-B'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('inbox-internal-note-compose')), 'Nova conversa');
    delayed.complete(http.Response(jsonEncode({
      'item': {'id': 'note-a', 'text': 'Rascunho antigo'},
      'duplicate': false,
    }), 200));
    await tester.pumpAndSettle();
    expect(find.text('Nova conversa'), findsOneWidget);
    await tester.tap(find.text('Guardar nota'));
    await tester.pumpAndSettle();
    expect(posts.length, 2);
    expect(posts[0], contains('/tenant-A/'));
    expect(posts[1], contains('/tenant-B/'));
    expect(tester.takeException(), isNull);
  });

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
