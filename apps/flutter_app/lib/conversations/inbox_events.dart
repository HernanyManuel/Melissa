import 'dart:convert';
import '../identity/api.dart';

/// Minimal event envelope: message bodies remain behind authorized REST endpoints.
class InboxEvent {
  const InboxEvent({
    required this.sequence,
    required this.type,
    required this.conversationId,
  });

  final String sequence;
  final String type;
  final String conversationId;
}

const _maxSequence = '9223372036854775807';
final _cursorPattern = RegExp(r'^\d{1,19}$');

bool validInboxCursor(String value) =>
    _cursorPattern.hasMatch(value) &&
    (value.length < _maxSequence.length ||
        value.compareTo(_maxSequence) <= 0);

/// SSE framing supports chunk boundaries, CRLF, comment heartbeats and replay.
Stream<InboxEvent> parseInboxEvents(Stream<List<int>> bytes) async* {
  String? eventId;
  String? type;
  final data = <String>[];

  await for (final line in bytes
      .map<List<int>>((chunk) => chunk)
      .transform(utf8.decoder)
      .transform(const LineSplitter())) {
    if (line.length > 8192) throw const FormatException('Inbox SSE line too long');
    if (line.isEmpty) {
      if (eventId != null && type != null && data.isNotEmpty) {
        if (!validInboxCursor(eventId)) {
          throw const FormatException('Invalid Inbox SSE cursor');
        }
        final jsonText = data.join('\n');
        if (jsonText.length > 8192) {
          throw const FormatException('Inbox SSE event too large');
        }
        final value = jsonDecode(jsonText);
        if (value is! Map<String, dynamic> ||
            value['conversationId'] is! String ||
            (value['conversationId'] as String).isEmpty ||
            !(type.startsWith('conversation.') || type.startsWith('message.'))) {
          throw const FormatException('Invalid Inbox SSE event');
        }
        yield InboxEvent(
          sequence: eventId,
          type: type,
          conversationId: value['conversationId'] as String,
        );
      }
      eventId = null;
      type = null;
      data.clear();
      continue;
    }
    if (line.startsWith(':')) continue;
    final separator = line.indexOf(':');
    final field = separator < 0 ? line : line.substring(0, separator);
    var value = separator < 0 ? '' : line.substring(separator + 1);
    if (value.startsWith(' ')) value = value.substring(1);
    switch (field) {
      case 'id':
        eventId = value;
      case 'event':
        type = value;
      case 'data':
        data.add(value);
    }
  }
}

/// Each reconnect creates a new authenticated request with the last applied ID.
Stream<InboxEvent> watchInboxEvents(
  IdentityApi api,
  String tenantId, {
  String? after,
}) async* {
  final response = await api.openInboxEvents(tenantId, after: after);
  yield* parseInboxEvents(response.stream);
}
