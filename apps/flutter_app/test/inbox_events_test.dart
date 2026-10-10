import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/conversations/inbox_events.dart';
import 'package:melissa/identity/api.dart';

void main() {
  test('parses split SSE UTF-8 frames, heartbeats, and tenant-local cursors', () async {
    final parts = <String>[
      'retry: 2000\n\n: keep-',
      'alive\n\nid: 1\nevent: message.received\n',
      'data: {"conversationId":"conversation-a","messageId":null,"createdAt":"now"}\n\n',
      'id: 2\r\nevent: conversation.takeover\r\ndata: {"conversationId":"conversation-b"}\r\n\r\n',
    ];
    final bytes = Stream<List<int>>.fromIterable(parts.map(utf8.encode));
    final events = await parseInboxEvents(bytes).toList();
    expect(events.map((event) => event.sequence).toList(), ['1', '2']);
    expect(events.map((event) => event.conversationId).toList(), [
      'conversation-a', 'conversation-b',
    ]);
    expect(validInboxCursor('9223372036854775807'), isTrue);
    expect(validInboxCursor('9223372036854775808'), isFalse);
    expect(validInboxCursor('-1'), isFalse);
  });

  test('invalid or oversized event fails closed without applying a cursor', () async {
    final invalid = Stream.value(utf8.encode(
      'id: 9223372036854775808\nevent: message.sent\n'
      'data: {"conversationId":"conversation-a"}\n\n',
    ));
    await expectLater(parseInboxEvents(invalid).toList(), throwsFormatException);
  });

  test('authorized stream sends replay cursor in both header and query', () async {
    final requests = <http.Request>[];
    final api = IdentityApi(client: MockClient((request) async {
      requests.add(request);
      if (request.url.path.endsWith('/auth/csrf')) {
        return http.Response('{"csrf_token":"csrf"}', 200);
      }
      if (request.url.path.endsWith('/auth/refresh')) {
        return http.Response('{"access_token":"access","csrf_token":"csrf"}', 200);
      }
      if (request.url.path.endsWith('/inbox/events')) {
        return http.Response(
          'retry: 2000\n\nid: 42\nevent: message.sent\n'
          'data: {"conversationId":"conv-1","messageId":"m-1"}\n\n',
          200, headers: {'content-type': 'text/event-stream; charset=utf-8'},
        );
      }
      return http.Response('{}', 404);
    }));
    addTearDown(api.dispose);
    final events = await watchInboxEvents(api, 'tenant-1', after: '41').toList();
    expect(events.single.sequence, '42');
    final request = requests.last;
    expect(request.headers['Authorization'], 'Bearer access');
    expect(request.headers['Last-Event-ID'], '41');
    expect(request.url.queryParameters['after'], '41');
    expect(request.headers['Accept'], 'text/event-stream');
  });

  test('missing tenant authorization is not reported as SSE content', () async {
    final api = IdentityApi(client: MockClient((request) async {
      if (request.url.path.endsWith('/auth/csrf')) {
        return http.Response('{"csrf_token":"csrf"}', 200);
      }
      if (request.url.path.endsWith('/auth/refresh')) {
        return http.Response('{"access_token":"access","csrf_token":"csrf"}', 200);
      }
      return http.Response('{"error":"forbidden"}', 403);
    }));
    addTearDown(api.dispose);
    await expectLater(watchInboxEvents(api, 'tenant-foreign').toList(),
      throwsA(isA<ApiFailure>().having((error) => error.status, 'status', 403)));
  });
}
