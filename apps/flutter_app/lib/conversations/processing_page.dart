import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';

class ProcessingPage extends StatefulWidget {
  const ProcessingPage({super.key, required this.tenantId, this.api});
  final String tenantId;
  final IdentityApi? api;
  @override
  State<ProcessingPage> createState() => _ProcessingPageState();
}
class _ProcessingPageState extends State<ProcessingPage> {
  late final IdentityApi api;
  List<Map<String, dynamic>> rows = [];
  String filter = 'pending';
  String? next;
  int generation = 0;
  bool busy = true, failed = false;
  @override
  void initState() { super.initState(); api = widget.api ?? IdentityApi(); load(); }
  @override
  void didUpdateWidget(covariant ProcessingPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tenantId != widget.tenantId) { filter = 'pending'; load(); }
  }
  @override
  void dispose() { if (widget.api == null) api.dispose(); super.dispose(); }

  Future<void> load({bool more = false}) async {
    final current = ++generation;
    final path = '/tenants/${widget.tenantId}/message-processing?state=$filter${more && next != null ? '&after=$next' : ''}';
    setState(() { busy = true; failed = false; if (!more) { rows = []; next = null; } });
    try {
      if (!api.authenticated) await api.refresh();
      final page = await api.request('GET', path) as Map<String, dynamic>;
      if (!mounted || current != generation) return;
      setState(() {
        final items = (page['items'] as List).cast<Map<String, dynamic>>();
        rows = more ? [...rows, ...items] : items; next = page['next'] as String?;
      });
    } catch (_) {
      if (mounted && current == generation) setState(() { failed = true; rows = []; next = null; });
    }
    if (mounted && current == generation) setState(() => busy = false);
  }

  String date(String raw) {
    final value = DateTime.parse(raw).toLocal();
    final l = MaterialLocalizations.of(context);
    return '${l.formatFullDate(value)} ${l.formatTimeOfDay(TimeOfDay.fromDateTime(value))}';
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final labels = {'pending': l.processingPending, 'failed': l.processingFailed, 'rejected': l.processingRejected};
    return Scaffold(appBar: AppBar(title: Text(l.processingTitle), leading: IconButton(
      tooltip: l.account, icon: const Icon(Icons.arrow_back), onPressed: () => context.go('/account')),
      actions: [IconButton(tooltip: l.retry, onPressed: busy ? null : () => load(), icon: const Icon(Icons.refresh))]),
      body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 900), child: ListView(
        padding: const EdgeInsets.all(24), children: [
          Text(l.processingHint), const SizedBox(height: 16),
          Wrap(spacing: 8, runSpacing: 8, children: [for (final entry in labels.entries)
            ChoiceChip(label: Text(entry.value), selected: filter == entry.key, onSelected: (_) { filter = entry.key; load(); })]),
          if (busy) const LinearProgressIndicator(),
          if (failed) ...[Text(l.actionError), TextButton(onPressed: () => load(), child: Text(l.retry))],
          if (!busy && !failed && rows.isEmpty) Padding(padding: const EdgeInsets.all(24), child: Text(l.processingEmpty)),
          for (final row in rows) Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(
            crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(labels[row['state']] ?? l.actionError, style: Theme.of(context).textTheme.titleMedium),
              SelectableText(row['id'] as String),
              Text('${l.processingAttempts}: ${row['attempts']}'),
              if (row['nextAttemptAt'] != null) Text('${l.processingEligible}: ${date(row['nextAttemptAt'] as String)}'),
            ]))),
          if (next != null) OutlinedButton(onPressed: busy ? null : () => load(more: true), child: Text(l.loadMore)),
        ]))),
    );
  }
}
