import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';

class QuarantinePage extends StatefulWidget {
  const QuarantinePage({super.key, required this.tenantId, this.api});
  final String tenantId;
  final IdentityApi? api;
  @override
  State<QuarantinePage> createState() => _QuarantinePageState();
}

class _QuarantinePageState extends State<QuarantinePage> {
  late final IdentityApi api;
  List<Map<String, dynamic>> rows = [];
  List<String> notices = [];
  String? next;
  int total = 0, expired = 0, soon = 0, capacity = 1000, generation = 0;
  bool loading = true, failed = false;

  @override
  void initState() { super.initState(); api = widget.api ?? IdentityApi(); load(); }
  @override
  void didUpdateWidget(covariant QuarantinePage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tenantId != widget.tenantId) load();
  }
  @override
  void dispose() { if (widget.api == null) api.dispose(); super.dispose(); }

  Future<void> load({bool more = false}) async {
    final requestGeneration = ++generation;
    final path = '/tenants/${widget.tenantId}/quarantine${more && next != null ? '?after=$next' : ''}';
    setState(() {
      loading = true; failed = false; notices = [];
      if (!more) { rows = []; next = null; total = 0; expired = 0; soon = 0; }
    });
    try {
      if (!api.authenticated) await api.refresh();
      final result = await api.request('GET', path) as Map<String, dynamic>;
      if (!mounted || requestGeneration != generation) return;
      setState(() {
        final items = (result['items'] as List).cast<Map<String, dynamic>>();
        rows = more ? [...rows, ...items] : items;
        next = result['next'] as String?;
        total = result['total'] as int; expired = result['expired'] as int;
        soon = result['expiringSoon'] as int; capacity = result['capacity'] as int;
        notices = (result['notices'] as List? ?? []).cast<String>();
      });
    } catch (_) {
      if (mounted && requestGeneration == generation) {
        setState(() {
          failed = true; rows = []; next = null; total = 0; expired = 0; soon = 0;
        });
      }
    }
    if (mounted && requestGeneration == generation) setState(() => loading = false);
  }

  String timestamp(String raw) {
    final date = DateTime.parse(raw).toLocal();
    final local = MaterialLocalizations.of(context);
    return '${local.formatMediumDate(date)} ${local.formatTimeOfDay(TimeOfDay.fromDateTime(date))}';
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final noticeLabels = {
      'capacity_full': l.quarantineFullWarning,
      'capacity_warning': l.quarantineCapacityWarning,
      'cleanup_pending': l.quarantineCleanupWarning,
      'expiring_soon': l.quarantineExpiryWarning,
    };
    return Scaffold(
      appBar: AppBar(title: Text(l.quarantine), leading: IconButton(
        tooltip: l.account, onPressed: () => context.go('/account'), icon: const Icon(Icons.arrow_back)),
        actions: [IconButton(tooltip: l.retry, onPressed: loading ? null : load,
          icon: const Icon(Icons.refresh))]),
      body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 960),
        child: ListView(padding: const EdgeInsets.all(20), children: [
          Text(l.quarantineReadOnly), const SizedBox(height: 16),
          if (loading) const LinearProgressIndicator(),
          for (final notice in notices.where(noticeLabels.containsKey))
            Semantics(liveRegion: true, child: Card(child: Padding(
              padding: const EdgeInsets.all(16), child: Row(crossAxisAlignment: CrossAxisAlignment.start,
                children: [const Icon(Icons.warning_amber_rounded), const SizedBox(width: 12),
                  Expanded(child: Text(noticeLabels[notice]!))])))),
          if (failed) ...[
            Text(l.actionError), const SizedBox(height: 12),
            OutlinedButton(onPressed: load, child: Text(l.retry)),
          ],
          if (!failed && !loading) Wrap(spacing: 12, runSpacing: 8, children: [
            Chip(label: Text('${l.quarantineStored}: $total / $capacity')),
            Chip(label: Text('${l.quarantineSoon}: $soon')),
            Chip(label: Text('${l.quarantineExpired}: $expired')),
          ]),
          if (!loading && !failed && rows.isEmpty) Padding(
            padding: const EdgeInsets.symmetric(vertical: 24), child: Text(l.quarantineEmpty)),
          for (final row in rows) Card(child: Padding(padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(row['channelName'] as String, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              Text('${l.quarantineReceived}: ${timestamp(row['createdAt'] as String)}'),
              Text('${l.quarantineExpires}: ${timestamp(row['expiresAt'] as String)}'),
              if (row['expired'] == true) Text(l.quarantineExpired),
              const SizedBox(height: 8), SelectableText(row['id'] as String),
            ]))),
          if (next != null) OutlinedButton(onPressed: loading ? null : () => load(more: true),
            child: Text(l.loadMore)),
        ]))),
    );
  }
}
