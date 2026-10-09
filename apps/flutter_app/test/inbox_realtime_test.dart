import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/conversations/conversations_page.dart';
import 'package:melissa/conversations/inbox_events.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

http.Response page(List<Object> rows) =>
    http.Response(jsonEncode({'items': rows, 'next': null}), 200);

Map<String, Object?> conversation(String id) => {
  'id': id, 'mode': 'AI_ACTIVE', 'status': 'open', 'assignedStaffId': null,
  'customer': {'displayName': 'Cliente $id'},
  'channelConnection': {'displayName': 'Canal', 'mode': 'mock'},
};

Map<String, Object?> message(String content) => {
  'id': content, 'contentText': content, 'direction': 'inbound',
  'createdAt': '2026-10-08T11:00:00Z',
};

IdentityApi apiFor(Future<http.Response> Function(http.Request) route) =>
    IdentityApi(client: MockClient((request) async {
      if (request.url.path.endsWith('/auth/csrf')) {
        return http.Response('{"csrf_token":"csrf"}', 200);
      }
      if (request.url.path.endsWith('/auth/refresh')) {
        return http.Response('{"access_token":"access","csrf_token":"csrf"}', 200);
      }
      if (request.url.path.endsWith('/staff')) return http.Response('[]', 200);
      return route(request);
    }));

Widget screen(IdentityApi api, InboxEventSource source, {String tenant = 'tenant-1'}) =>
    MaterialApp(
      locale: const Locale('pt'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: ConversationsPage(tenantId: tenant, api: api, eventSource: source),
    );

void main() {
  testWidgets('SSE event refreshes selected history without replacing selection', (tester) async {
    final events = StreamController<InboxEvent>.broadcast();
    addTearDown(events.close);
    var messageVersion = 1;
    final api = apiFor((request) async {
      if (request.url.path.endsWith('/conversations')) {
        return page([conversation('A'), conversation('B')]);
      }
      if (request.url.path.endsWith('/A/messages')) {
        return page([message('Primeira'), if (messageVersion == 2) message('Segunda')]);
      }
      if (request.url.path.endsWith('/B/messages')) return page([message('Outra')]);
      return http.Response('{}', 404);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api, (_, __) => events.stream));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cliente A'));
    await tester.pumpAndSettle();
    expect(find.text('Primeira'), findsOneWidget);
    messageVersion = 2;
    events.add(const InboxEvent(
      sequence: '1', type: 'message.received', conversationId: 'A',
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    expect(find.text('Segunda'), findsOneWidget);
    expect(find.text('Cliente A'), findsWidgets);
    expect(find.text('Outra'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('new-message alert requires verified unread increase and clears on read', (tester) async {
    final events = StreamController<InboxEvent>.broadcast();
    addTearDown(events.close);
    var unread = 0;
    var readCalls = 0;
    final api = apiFor((request) async {
      if (request.url.path.endsWith('/conversations')) {
        return page([{
          ...conversation('A'),
          'unreadCount': unread,
          'unreadUpTo': unread > 0 ? '12' : null,
        }]);
      }
      if (request.url.path.endsWith('/A/messages')) return page([message('Olá')]);
      if (request.url.path.endsWith('/A/read')) {
        readCalls++;
        unread = 0;
        return http.Response('{"unreadUpTo":"12"}', 200);
      }
      return page([]);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api, (_, __) => events.stream));
    await tester.pumpAndSettle();
    expect(find.text('Novas mensagens recebidas'), findsNothing);
    unread = 1;
    events.add(const InboxEvent(
      sequence: '12', type: 'message.received', conversationId: 'A',
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    expect(find.text('Novas mensagens recebidas'), findsWidgets);
    await tester.tap(find.text('Cliente A'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Marcar como lida'));
    await tester.pumpAndSettle();
    expect(readCalls, 1);
    expect(find.text('Novas mensagens recebidas'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('reconnect resumes from last applied cursor and ignores replay', (tester) async {
    final sessions = <StreamController<InboxEvent>>[];
    final cursors = <String?>[];
    var listRequests = 0;
    final api = apiFor((request) async {
      if (request.url.path.endsWith('/conversations')) {
        listRequests++;
        return page([conversation('A')]);
      }
      return page([]);
    });
    addTearDown(api.dispose);
    Stream<InboxEvent> source(String tenant, String? after) {
      cursors.add(after);
      final session = StreamController<InboxEvent>();
      sessions.add(session);
      return session.stream;
    }
    await tester.pumpWidget(screen(api, source));
    await tester.pumpAndSettle();
    sessions.single.add(const InboxEvent(
      sequence: '42', type: 'conversation.takeover', conversationId: 'A',
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    final beforeReplay = listRequests;
    await sessions.single.close();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump();
    expect(cursors, [null, '42']);
    sessions.last.add(const InboxEvent(
      sequence: '42', type: 'conversation.takeover', conversationId: 'A',
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(listRequests, beforeReplay);
    sessions.last.add(const InboxEvent(
      sequence: '43', type: 'conversation.closed', conversationId: 'A',
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    expect(listRequests, greaterThan(beforeReplay));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    for (final session in sessions) {
      if (!session.isClosed) unawaited(session.close());
    }
  });

  testWidgets('SSE burst keeps both refreshes when the first REST snapshot is slow', (tester) async {
    final events = StreamController<InboxEvent>.broadcast();
    addTearDown(events.close);
    final delayed = Completer<http.Response>();
    var listRequests = 0;
    final api = apiFor((request) async {
      if (request.url.path.endsWith('/conversations')) {
        listRequests++;
        if (listRequests == 2) return delayed.future;
        return page([conversation('A'), conversation('B')]);
      }
      return page([]);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(screen(api, (_, __) => events.stream));
    await tester.pumpAndSettle();
    expect(listRequests, 1);

    events.add(const InboxEvent(
      sequence: '1', type: 'message.received', conversationId: 'A',
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(listRequests, 2);

    events.add(const InboxEvent(
      sequence: '2', type: 'message.received', conversationId: 'B',
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    // The second event must not start an overlapping REST snapshot.
    expect(listRequests, 2);

    delayed.complete(page([conversation('A'), conversation('B')]));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    // Buffered second event triggers the next authorized REST refresh.
    expect(listRequests, 3);
    expect(find.text('Cliente A'), findsOneWidget);
    expect(find.text('Cliente B'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('tenant change resets event cursor and hides previous customer data', (tester) async {
    final streams = <StreamController<InboxEvent>>[];
    final captured = <String>[];
    final api = apiFor((request) async {
      if (request.url.path.endsWith('/conversations')) {
        return page([conversation(request.url.path.contains('tenant-2') ? 'B' : 'A')]);
      }
      return page([]);
    });
    addTearDown(api.dispose);
    Stream<InboxEvent> source(String tenant, String? after) {
      captured.add('$tenant:${after ?? 'start'}');
      final stream = StreamController<InboxEvent>();
      streams.add(stream);
      return stream.stream;
    }
    await tester.pumpWidget(screen(api, source));
    await tester.pumpAndSettle();
    streams.first.add(const InboxEvent(
      sequence: '9', type: 'message.received', conversationId: 'A',
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    await tester.pumpWidget(screen(api, source, tenant: 'tenant-2'));
    await tester.pumpAndSettle();
    expect(captured, ['tenant-1:start', 'tenant-2:start']);
    expect(find.text('Cliente A'), findsNothing);
    expect(find.text('Cliente B'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    for (final stream in streams) {
      if (!stream.isClosed) unawaited(stream.close());
    }
    expect(tester.takeException(), isNull);
  });
}
