import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/conversations/human_controls.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

Map<String, dynamic> conversation(String id, String mode, {String channel = 'live'}) => {
  'id': id,
  'mode': mode,
  'status': 'open',
  'assignedStaffId': mode == 'HUMAN_ACTIVE' ? 'staff-1' : null,
  'channelConnection': {'mode': channel},
};

http.Response jsonResponse(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status,
      headers: {'content-type': 'application/json; charset=utf-8'});

IdentityApi fake(Future<http.Response> Function(http.Request) handle, {
  Future<http.Response> Function(http.Request)? latest,
}) =>
    IdentityApi(client: MockClient((request) async {
      if (request.url.path.endsWith('/auth/csrf')) {
        return jsonResponse({'csrf_token': 'csrf'});
      }
      if (request.url.path.endsWith('/auth/refresh')) {
        return jsonResponse({'access_token': 'test', 'csrf_token': 'csrf'});
      }
      if (request.url.path.endsWith('/manual-replies/latest')) {
        return latest == null ? jsonResponse({'item': null}) : latest(request);
      }
      if (request.url.path.endsWith('/manual-replies/prepare')) {
        return jsonResponse({'intentId': 'prepared-intent', 'state': 'prepared'});
      }
      return handle(request);
    }));

Widget frame(IdentityApi api, Map<String, dynamic> initial, {
  ValueChanged<Map<String, dynamic>>? changed,
  VoidCallback? revoked,
}) {
  var current = initial;
  return MaterialApp(
    locale: const Locale('pt'),
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: Scaffold(body: StatefulBuilder(builder: (context, refresh) {
      return SingleChildScrollView(child: ConversationHumanControls(
        key: ValueKey(current['id']),
        tenantId: 'tenant-1',
        conversation: current,
        api: api,
        onChanged: (next) {
          refresh(() => current = next);
          changed?.call(next);
        },
        onRevoked: revoked ?? () {},
      ));
    })),
  );
}

void main() {
  testWidgets('takeover, durable reply replay and AI reactivation', (tester) async {
    final replies = <String>[];
    final commands = <String>[];
    final api = fake((request) async {
      final path = request.url.path;
      if (path.endsWith('/staff')) {
        return jsonResponse([{'id': 'staff-1', 'name': 'Ana', 'active': true}]);
      }
      if (path.endsWith('/takeover')) {
        commands.add('takeover');
        expect(jsonDecode(request.body)['staffId'], 'staff-1');
        return jsonResponse({
          'id': 'conversation-1', 'mode': 'HUMAN_ACTIVE', 'status': 'open',
          'assignedStaffId': 'staff-1', 'closedAt': null,
        });
      }
      if (path.endsWith('/reactivate-ai')) {
        commands.add('reactivate');
        return jsonResponse({
          'id': 'conversation-1', 'mode': 'AI_ACTIVE', 'status': 'open',
          'assignedStaffId': null, 'closedAt': null,
        });
      }
      if (path.endsWith('/messages') && request.method == 'POST') {
        replies.add(request.body);
        return replies.length == 1
            ? jsonResponse({'error': 'TEMPORARILY_UNAVAILABLE'}, 503)
            : jsonResponse({'intentId': 'intent-1', 'duplicate': true, 'state': 'pending'});
      }
      return jsonResponse({}, 404);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(frame(api, conversation('conversation-1', 'WAITING_HUMAN')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('inbox-staff')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Ana').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Assumir conversa'));
    await tester.pumpAndSettle();
    expect(commands, ['takeover']);
    expect(find.text('Atendimento humano'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('inbox-compose')), 'Olá, estou a ajudar.');
    await tester.tap(find.text('Resposta manual').last);
    await tester.pumpAndSettle();
    expect(find.text('Resultado incerto. Repete apenas com a mesma chave e texto.'), findsOneWidget);
    await tester.tap(find.text('Repetir a mesma tentativa'));
    await tester.pumpAndSettle();
    expect(replies.length, 2);
    expect(replies[0], replies[1]);
    final sent = jsonDecode(replies.first) as Map<String, dynamic>;
    expect(sent['text'], 'Olá, estou a ajudar.');
    expect((sent['requestId'] as String).length, 36);
    expect(find.text('Resposta guardada na fila. Ainda não foi confirmada pelo WhatsApp.'), findsOneWidget);

    await tester.tap(find.text('Reativar IA'));
    await tester.pumpAndSettle();
    expect(commands, ['takeover', 'reactivate']);
    expect(find.byKey(const Key('inbox-compose')), findsNothing);
    expect(tester.takeException(), isNull);
  });


  testWidgets('restores own durable reply after widget reload without a POST', (tester) async {
    var sent = 0;
    final api = fake((request) async {
      if (request.method == 'POST' && request.url.path.endsWith('/messages')) {
        sent++;
        return jsonResponse({'intentId': 'new-intent', 'state': 'pending'});
      }
      return jsonResponse({}, 404);
    }, latest: (_) async => jsonResponse({'item': {
      'intentId': 'prior-intent',
      'requestId': '78c98362-e381-4c1d-b0fb-2a3fa06c2b38',
      'text': 'Mensagem anterior',
      'state': 'pending',
      'createdAt': '2026-10-09T07:00:00Z',
    }}));
    addTearDown(api.dispose);
    await tester.pumpWidget(frame(api, conversation('convo-a', 'HUMAN_ACTIVE')));
    await tester.pumpAndSettle();
    expect(sent, 0);
    expect(find.text('Mensagem anterior'), findsOneWidget);
    expect(find.text('Resposta anterior recuperada. Não foi efetuado um novo envio.'),
      findsOneWidget);
    expect(find.byKey(const Key('inbox-compose')), findsNothing);
    // Recreating the page must not automatically replay the prior POST.
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(frame(api, conversation('convo-a', 'HUMAN_ACTIVE')));
    await tester.pumpAndSettle();
    expect(sent, 0);
    expect(find.text('Mensagem anterior'), findsOneWidget);
    await tester.tap(find.text('Nova resposta'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('inbox-compose')), findsOneWidget);
    expect(sent, 0);
  });

  testWidgets('uncertain POST reconciles to existing intent without resending', (tester) async {
    Map<String, dynamic>? written;
    var writes = 0;
    final api = fake((request) async {
      if (request.method == 'POST' && request.url.path.endsWith('/messages')) {
        writes++;
        written = jsonDecode(request.body) as Map<String, dynamic>;
        return jsonResponse({'error': 'TEMPORARILY_UNAVAILABLE'}, 503);
      }
      return jsonResponse({}, 404);
    }, latest: (_) async => jsonResponse({'item': written == null ? null : {
      'intentId': 'persisted-intent',
      'requestId': written!['requestId'],
      'text': written!['text'],
      'state': 'pending',
      'createdAt': '2026-10-09T07:00:00Z',
    }}));
    addTearDown(api.dispose);
    await tester.pumpWidget(frame(api, conversation('convo-a', 'HUMAN_ACTIVE')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('inbox-compose')), 'Comprovadamente persistida');
    await tester.tap(find.text('Resposta manual').last);
    await tester.pumpAndSettle();
    expect(writes, 1);
    expect(find.text('Resposta guardada na fila. Ainda não foi confirmada pelo WhatsApp.'),
      findsOneWidget);
    expect(find.text('Comprovadamente persistida'), findsOneWidget);
    expect(find.text('Resultado incerto. Repete apenas com a mesma chave e texto.'),
      findsNothing);
  });

  testWidgets('a failed initial check blocks new sends until GET succeeds', (tester) async {
    var denied = true;
    var sends = 0;
    final api = fake((request) async {
      if (request.method == 'POST' && request.url.path.endsWith('/messages')) {
        sends++;
      }
      return jsonResponse({}, 404);
    }, latest: (_) async => denied ? jsonResponse({}, 503) :
      jsonResponse({'item': null}));
    addTearDown(api.dispose);
    await tester.pumpWidget(frame(api, conversation('convo-a', 'HUMAN_ACTIVE')));
    await tester.pumpAndSettle();
    expect(find.text('Não foi possível consultar a resposta anterior. Verifica novamente antes de criar outra.'),
      findsOneWidget);
    expect(tester.widget<TextField>(find.byKey(const Key('inbox-compose'))).enabled, false);
    denied = false;
    await tester.tap(find.text('Verificar resposta anterior'));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(find.byKey(const Key('inbox-compose'))).enabled, true);
    expect(sends, 0);
  });

  testWidgets('reloaded prepared reply requires explicit confirmation with same key/text', (tester) async {
    final posts = <Map<String, dynamic>>[];
    final api = fake((request) async {
      if (request.method == 'POST' && request.url.path.endsWith('/messages')) {
        posts.add(jsonDecode(request.body) as Map<String, dynamic>);
        return jsonResponse({'intentId': 'prepared-1', 'state': 'pending'});
      }
      return jsonResponse({}, 404);
    }, latest: (_) async => jsonResponse({'item': {
      'intentId': 'prepared-1',
      'requestId': '30b17e74-a4fc-4b17-abcf-fad2bebfb52b',
      'text': 'Aguarda confirmação',
      'state': 'prepared',
      'createdAt': '2026-10-09T07:00:00Z',
    }}));
    addTearDown(api.dispose);
    await tester.pumpWidget(frame(api, conversation('convo-a', 'HUMAN_ACTIVE')));
    await tester.pumpAndSettle();
    expect(posts, isEmpty);
    expect(find.text('Resposta preparada no servidor. Ainda não foi colocada na fila de envio.'),
        findsOneWidget);
    expect(find.text('Aguarda confirmação'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(frame(api, conversation('convo-a', 'HUMAN_ACTIVE')));
    await tester.pumpAndSettle();
    expect(posts, isEmpty);
    await tester.tap(find.text('Confirmar envio da resposta'));
    await tester.pumpAndSettle();
    expect(posts, hasLength(1));
    expect(posts.single, {
      'requestId': '30b17e74-a4fc-4b17-abcf-fad2bebfb52b',
      'text': 'Aguarda confirmação',
    });
    expect(find.text('Resposta guardada na fila. Ainda não foi confirmada pelo WhatsApp.'),
      findsOneWidget);
  });


  testWidgets('abandoning a restored preparation never sends a message', (tester) async {
    var sends = 0;
    var abandoned = 0;
    const requestId = '30b17e74-a4fc-4b17-abcf-fad2bebfb52b';
    final api = fake((request) async {
      if (request.url.path.endsWith('/manual-replies/abandon')) {
        abandoned++;
        expect(jsonDecode(request.body)['requestId'], requestId);
        return jsonResponse({'intentId': 'prepared-1', 'state': 'abandoned', 'duplicate': false});
      }
      if (request.url.path.endsWith('/messages') && request.method == 'POST') {
        sends++;
      }
      return jsonResponse({}, 404);
    }, latest: (_) async => jsonResponse({'item': {
      'intentId': 'prepared-1',
      'requestId': requestId,
      'text': 'Mensagem não enviada',
      'state': 'prepared',
      'createdAt': '2026-10-09T07:00:00Z',
    }}));
    addTearDown(api.dispose);
    await tester.pumpWidget(frame(api, conversation('convo-a', 'HUMAN_ACTIVE')));
    await tester.pumpAndSettle();
    expect(find.text('Abandonar preparação'), findsOneWidget);
    await tester.tap(find.text('Abandonar preparação'));
    await tester.pumpAndSettle();
    expect(abandoned, 1);
    expect(sends, 0);
    expect(find.text('Preparação abandonada. Nenhuma mensagem foi enviada.'),
      findsOneWidget);
    expect(find.text('Confirmar envio da resposta'), findsNothing);
    await tester.tap(find.text('Nova resposta'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('inbox-compose')), findsOneWidget);
    expect(sends, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('redacted abandoned receipt hides text and cannot send', (tester) async {
    var sends = 0;
    final api = fake((request) async {
      if (request.method == 'POST' && request.url.path.endsWith('/messages')) sends++;
      return jsonResponse({}, 404);
    }, latest: (_) async => jsonResponse({'item': {
      'intentId': 'tombstone-1',
      'requestId': '30b17e74-a4fc-4b17-abcf-fad2bebfb52b',
      'text': null,
      'state': 'abandoned',
      'createdAt': '2026-10-09T07:00:00Z',
    }}));
    addTearDown(api.dispose);
    await tester.pumpWidget(frame(api, conversation('convo-a', 'HUMAN_ACTIVE')));
    await tester.pumpAndSettle();
    expect(find.text('Preparação abandonada. Nenhuma mensagem foi enviada.'),
      findsOneWidget);
    expect(find.byKey(const Key('inbox-compose')), findsNothing);
    expect(find.text('Confirmar envio da resposta'), findsNothing);
    expect(sends, 0);
    await tester.tap(find.text('Nova resposta'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('inbox-compose')), findsOneWidget);
    expect(sends, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('expired preparation cannot be confirmed or automatically sent', (tester) async {
    var sends = 0;
    final api = fake((request) async {
      if (request.method == 'POST' && request.url.path.endsWith('/messages')) {
        sends++;
      }
      return jsonResponse({}, 404);
    }, latest: (_) async => jsonResponse({'item': {
      'intentId': 'expired-1',
      'requestId': 'f44272cd-56e2-43d4-afd2-6b7b62ed2dde',
      'text': 'Preparação antiga',
      'state': 'expired',
      'createdAt': '2026-10-07T07:00:00Z',
    }}));
    addTearDown(api.dispose);
    await tester.pumpWidget(frame(api, conversation('convo-a', 'HUMAN_ACTIVE')));
    await tester.pumpAndSettle();
    expect(find.text('Preparação expirada ao fim de 24 horas. Não foi enviada.'),
      findsOneWidget);
    expect(find.text('Confirmar envio da resposta'), findsNothing);
    expect(find.text('Nova resposta'), findsOneWidget);
    expect(sends, 0);
    await tester.tap(find.text('Nova resposta'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('inbox-compose')), findsOneWidget);
    expect(sends, 0);
  });

  testWidgets('mock human conversation never exposes live composer and can close', (tester) async {
    var closes = 0;
    final api = fake((request) async {
      if (request.url.path.endsWith('/close')) {
        closes++;
        return jsonResponse({
          'id': 'conversation-2', 'mode': 'CLOSED', 'status': 'closed',
          'assignedStaffId': null, 'closedAt': '2026-10-08T00:00:00Z',
        });
      }
      return jsonResponse({}, 404);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(frame(
      api, conversation('conversation-2', 'HUMAN_ACTIVE', channel: 'mock'),
    ));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('inbox-compose')), findsNothing);
    expect(find.text('Marcar resolvida'), findsOneWidget);
    await tester.tap(find.text('Marcar resolvida'));
    await tester.pumpAndSettle();
    expect(closes, 1);
    expect(find.text('Conversa fechada'), findsOneWidget);
    expect(find.text('Marcar resolvida'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('late reply response cannot overwrite a different conversation', (tester) async {
    final hold = Completer<http.Response>();
    final api = fake((request) async {
      if (request.url.path.endsWith('/messages')) return hold.future;
      return jsonResponse({}, 404);
    });
    addTearDown(api.dispose);
    var current = conversation('first', 'HUMAN_ACTIVE');
    late StateSetter update;
    await tester.pumpWidget(MaterialApp(
      locale: const Locale('pt'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(body: StatefulBuilder(builder: (context, refresh) {
        update = refresh;
        return Column(children: [
          TextButton(onPressed: () => refresh(() {
            current = conversation('second', 'HUMAN_ACTIVE');
          }), child: const Text('Trocar')),
          ConversationHumanControls(
            key: ValueKey(current['id']),
            tenantId: 'tenant-1', conversation: current, api: api,
            onChanged: (next) => refresh(() => current = next),
            onRevoked: () {},
          ),
        ]);
      })),
    ));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('inbox-compose')), 'Tentativa original');
    await tester.tap(find.text('Resposta manual').last);
    await tester.pump();
    await tester.tap(find.text('Trocar'));
    await tester.pump();
    hold.complete(jsonResponse({'intentId': 'old', 'state': 'pending'}));
    await tester.pumpAndSettle();
    expect(find.text('Resposta guardada na fila. Ainda não foi confirmada pelo WhatsApp.'), findsNothing);
    expect(find.byKey(const Key('inbox-compose')), findsOneWidget);
    expect(tester.takeException(), isNull);
    // Keep the state setter exercised so the builder is not a dead test fixture.
    update(() {});
  });
}
