import 'package:flutter/material.dart';
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';

/// Tenant-scoped metadata only. No path in this widget can enqueue messages.
class ConversationTags extends StatefulWidget {
  const ConversationTags({
    super.key,
    required this.tenantId,
    required this.conversationId,
    required this.api,
  });

  final String tenantId;
  final String conversationId;
  final IdentityApi api;

  @override
  State<ConversationTags> createState() => _ConversationTagsState();
}

class _ConversationTagsState extends State<ConversationTags> {
  final name = TextEditingController();
  List<Map<String, dynamic>> available = [];
  Set<String> applied = {};
  bool loading = false;
  bool busy = false;
  bool failed = false;
  int generation = 0;

  String get path =>
      '/tenants/${widget.tenantId}/conversations/${widget.conversationId}/tags';
  String get catalogPath => '/tenants/${widget.tenantId}/conversation-tags';

  @override
  void initState() {
    super.initState();
    load();
  }

  @override
  void didUpdateWidget(covariant ConversationTags oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tenantId != widget.tenantId ||
        oldWidget.conversationId != widget.conversationId) {
      generation++;
      loading = false;
      busy = false;
      failed = false;
      available = [];
      applied = {};
      name.clear();
      load();
    }
  }

  @override
  void dispose() {
    generation++;
    name.dispose();
    super.dispose();
  }

  Future<void> load() async {
    final version = ++generation;
    setState(() { loading = true; failed = false; });
    try {
      final result = await widget.api.request('GET', path) as Map<String, dynamic>;
      if (!mounted || generation != version) return;
      final tags = (result['available'] as List).cast<Map<String, dynamic>>();
      final assigned = (result['applied'] as List).cast<String>();
      setState(() {
        available = tags;
        applied = assigned.toSet();
      });
    } catch (_) {
      if (!mounted || generation != version) return;
      setState(() {
        available = [];
        applied = {};
        failed = true;
      });
    } finally {
      if (mounted && generation == version) setState(() => loading = false);
    }
  }

  Future<void> changeTag(String tagId, bool attach) async {
    if (loading || busy) return;
    final version = generation;
    final tenant = widget.tenantId;
    final conversation = widget.conversationId;
    setState(() { busy = true; failed = false; });
    try {
      final response = await widget.api.request(
        attach ? 'POST' : 'DELETE', '$path/$tagId',
        null, false,
      ) as Map<String, dynamic>;
      if (response['attached'] != attach) throw const FormatException('Invalid tag receipt');
      if (!mounted || version != generation) return;
      // Read-only refresh after the write, never infer state from an
      // ambiguous response or dispatch anything to customers.
      await load();
    } catch (_) {
      if (mounted && version == generation) setState(() => failed = true);
    } finally {
      if (mounted && tenant == widget.tenantId && conversation == widget.conversationId) {
        setState(() => busy = false);
      }
    }
  }

  Future<void> createTag() async {
    if (loading || busy) return;
    final original = name.text.trim();
    if (original.isEmpty || original.runes.length > 40) return;
    final version = generation;
    final tenant = widget.tenantId;
    final conversation = widget.conversationId;
    setState(() { busy = true; failed = false; });
    try {
      final response = await widget.api.request(
        'POST', catalogPath, {'name': original}, false,
      ) as Map<String, dynamic>;
      final item = response['item'];
      if (item is! Map<String, dynamic> || item['id'] is! String ||
          item['name'] != original) {
        throw const FormatException('Invalid tag catalog receipt');
      }
      if (!mounted || version != generation) return;
      name.clear();
      await load();
    } catch (_) {
      if (mounted && version == generation) setState(() => failed = true);
    } finally {
      if (mounted && tenant == widget.tenantId && conversation == widget.conversationId) {
        setState(() => busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      ListTile(
        dense: true,
        leading: const Icon(Icons.label_outline),
        title: Text(l.inboxTags),
        trailing: IconButton(
          tooltip: l.retry, icon: const Icon(Icons.refresh),
          onPressed: loading || busy ? null : load,
        ),
      ),
      if (loading) const LinearProgressIndicator(),
      if (failed) TextButton(
        onPressed: loading || busy ? null : load, child: Text(l.retry),
      ),
      if (!loading && available.isNotEmpty)
        Wrap(spacing: 8, children: [
          for (final tag in available)
            FilterChip(
              label: Text(tag['name'] as String),
              selected: applied.contains(tag['id']),
              onSelected: busy ? null : (value) => changeTag(tag['id'] as String, value),
            ),
        ]),
      Row(children: [
        Expanded(child: TextField(
          key: const Key('inbox-tag-name'),
          controller: name, maxLength: 40,
          enabled: !busy && !loading,
          decoration: InputDecoration(labelText: l.inboxNewTag),
        )),
        IconButton(
          tooltip: l.inboxCreateTag,
          onPressed: busy || loading ? null : createTag,
          icon: const Icon(Icons.add_circle_outline),
        ),
      ]),
    ]);
  }
}
