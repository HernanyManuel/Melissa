import 'package:flutter/material.dart';
import '../channels/simulation_page.dart' show simulationId;
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';

/// Append-only private team notes; never calls /messages or a provider endpoint.
/// A failed POST keeps the original requestId and text for an idempotent retry.
class ConversationInternalNotes extends StatefulWidget {
  const ConversationInternalNotes({
    super.key,
    required this.tenantId,
    required this.conversationId,
    required this.api,
  });

  final String tenantId;
  final String conversationId;
  final IdentityApi api;

  @override
  State<ConversationInternalNotes> createState() => _ConversationInternalNotesState();
}

class _ConversationInternalNotesState extends State<ConversationInternalNotes> {
  final compose = TextEditingController();
  List<Map<String, dynamic>> notes = [];
  String? next;
  String? pendingId;
  String? pendingText;
  bool loading = false;
  bool posting = false;
  bool failed = false;
  bool postFailed = false;
  int generation = 0;

  String get path =>
      '/tenants/${widget.tenantId}/conversations/${widget.conversationId}/internal-notes';

  @override
  void initState() {
    super.initState();
    load();
  }

  @override
  void didUpdateWidget(covariant ConversationInternalNotes oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tenantId != widget.tenantId ||
        oldWidget.conversationId != widget.conversationId) {
      generation++;
      notes = [];
      next = null;
      pendingId = null;
      pendingText = null;
      posting = false;
      loading = false;
      failed = false;
      postFailed = false;
      compose.clear();
      load();
    }
  }

  @override
  void dispose() {
    generation++;
    compose.dispose();
    super.dispose();
  }

  Future<void> load({bool more = false}) async {
    if (loading) return;
    final version = ++generation;
    setState(() { loading = true; failed = false; });
    try {
      final suffix = more && next != null ? '?after=$next' : '';
      final result = await widget.api.request('GET', '$path$suffix')
          as Map<String, dynamic>;
      if (!mounted || version != generation) return;
      final items = (result['items'] as List).cast<Map<String, dynamic>>();
      setState(() {
        notes = more ? [...notes, ...items] : items;
        next = result['next'] as String?;
      });
    } catch (_) {
      if (mounted && version == generation) setState(() => failed = true);
    } finally {
      if (mounted && version == generation) setState(() => loading = false);
    }
  }

  Future<void> submit() async {
    if (posting || loading) return;
    if (pendingId == null) {
      final text = compose.text;
      if (text.trim().isEmpty || text.runes.length > 2000) return;
      pendingId = simulationId();
      pendingText = text;
    }
    final requestId = pendingId!;
    final text = pendingText!;
    final submitGeneration = generation;
    final submitTenant = widget.tenantId;
    final submitConversation = widget.conversationId;
    setState(() { posting = true; postFailed = false; });
    try {
      final receipt = await widget.api.request('POST', path,
          {'requestId': requestId, 'text': text}, false) as Map<String, dynamic>;
      if (!mounted || submitGeneration != generation ||
          submitTenant != widget.tenantId ||
          submitConversation != widget.conversationId) {
        return;
      }
      final item = receipt['item'];
      if (item is! Map<String, dynamic> || item['id'] is! String ||
          item['text'] != text) {
        throw const FormatException('Invalid internal note receipt');
      }
      setState(() {
        pendingId = null;
        pendingText = null;
        compose.clear();
      });
      // Read-only refresh; never infer delivery or submit an additional POST.
      await load();
    } catch (_) {
      if (mounted && submitGeneration == generation &&
          submitTenant == widget.tenantId &&
          submitConversation == widget.conversationId) {
        setState(() => postFailed = true);
      }
    } finally {
      if (mounted && submitGeneration == generation &&
          submitTenant == widget.tenantId &&
          submitConversation == widget.conversationId) {
        setState(() => posting = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      ListTile(
        dense: true,
        leading: const Icon(Icons.sticky_note_2_outlined),
        title: Text(l.inboxInternalNotes),
        subtitle: Text(l.inboxInternalNotesPrivate),
        trailing: IconButton(
          tooltip: l.retry,
          icon: const Icon(Icons.refresh),
          onPressed: loading ? null : () => load(),
        ),
      ),
      if (loading) const LinearProgressIndicator(),
      if (failed) TextButton(onPressed: loading ? null : () => load(),
          child: Text(l.retry)),
      if (notes.isNotEmpty) SizedBox(
        height: 128,
        child: ListView(children: [
          for (final note in notes)
            ListTile(
              dense: true,
              title: SelectableText(note['text'] as String),
              subtitle: Text(note['createdAt'] as String? ?? ''),
            ),
          if (next != null) TextButton(
            onPressed: loading ? null : () => load(more: true),
            child: Text(l.loadMore),
          ),
        ]),
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: TextField(
          key: const Key('inbox-internal-note-compose'),
          controller: compose,
          enabled: pendingId == null && !posting,
          maxLength: 2000,
          minLines: 1,
          maxLines: 3,
          decoration: InputDecoration(labelText: l.inboxInternalNoteHint),
        ),
      ),
      if (postFailed) Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Text(l.inboxInternalNoteUncertain),
      ),
      Align(
        alignment: Alignment.centerRight,
        child: TextButton.icon(
          onPressed: posting || loading ? null : submit,
          icon: const Icon(Icons.note_add_outlined),
          label: Text(pendingId == null
              ? l.inboxAddInternalNote : l.inboxRetryInternalNote),
        ),
      ),
    ]);
  }
}
