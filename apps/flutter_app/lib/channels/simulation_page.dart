import 'dart:math';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';

String simulationId() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

class SimulationPage extends StatefulWidget {
  const SimulationPage({super.key, required this.tenantId, required this.channelId, this.api});
  final String tenantId, channelId;
  final IdentityApi? api;
  @override
  State<SimulationPage> createState() => _SimulationPageState();
}

class _SimulationPageState extends State<SimulationPage> {
  late final IdentityApi api;
  final text = TextEditingController();
  final form = GlobalKey<FormState>();
  List<Map<String, dynamic>> customers = [];
  String? customerId, next, receiptId, state;
  Map<String, Object?>? pending;
  bool busy = true, ready = false, failed = false, blocked = false;
  int generation = 0;
  String get base => '/tenants/${widget.tenantId}';
  bool get terminal => ['processed', 'rejected', 'failed'].contains(state);

  @override
  void initState() { super.initState(); api = widget.api ?? IdentityApi(); load(); }
  @override
  void didUpdateWidget(covariant SimulationPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tenantId != widget.tenantId || oldWidget.channelId != widget.channelId) {
      pending = null; receiptId = null; state = null; customerId = null; text.clear(); load();
    }
  }
  @override
  void dispose() { text.dispose(); if (widget.api == null) api.dispose(); super.dispose(); }

  Future<void> load({bool more = false}) async {
    final current = ++generation;
    final tenantBase = base;
    final channelId = widget.channelId;
    final cursor = more ? next : null;
    setState(() { busy = true; failed = false; blocked = false; ready = false;
      if (!more) { customers = []; customerId = null; next = null; }
    });
    try {
      if (!api.authenticated) await api.refresh();
      final channels = await api.request('GET', '$tenantBase/channels') as List;
      if (!channels.any((c) => c['id'] == channelId && c['mode'] == 'mock' && c['status'] == 'active')) {
        throw const ApiFailure(403);
      }
      final page = await api.request('GET', '$tenantBase/customers${cursor == null ? '' : '?after=$cursor'}') as Map<String, dynamic>;
      if (!mounted || current != generation) return;
      setState(() {
        final items = (page['items'] as List).cast<Map<String, dynamic>>();
        customers = more ? [...customers, ...items] : items;
        next = page['next'] as String?; ready = true;
      });
    } catch (_) {
      if (mounted && current == generation) setState(() { failed = true; customers = []; customerId = null; });
    }
    if (mounted && current == generation) setState(() => busy = false);
  }

  Future<void> submit() async {
    if (busy || blocked || receiptId != null) return;
    if (pending == null) {
      if (!ready || !form.currentState!.validate()) return;
      pending = Map.unmodifiable({'customerId': customerId!, 'eventId': simulationId(), 'text': text.text});
    }
    final current = ++generation;
    final path = '$base/channels/${widget.channelId}/mock-inbound';
    setState(() { busy = true; failed = false; });
    try {
      final result = await api.request('POST', path, pending) as Map<String, dynamic>;
      if (!mounted || current != generation) return;
      setState(() { receiptId = result['eventId'] as String; state = 'pending'; });
    } catch (error) {
      if (mounted && current == generation) handleError(error);
    }
    if (mounted && current == generation) setState(() => busy = false);
  }

  void handleError(Object error) {
    setState(() {
      failed = true;
      if (error is ApiFailure && [400, 401, 403, 404, 409].contains(error.status)) {
        blocked = true; ready = false; customers = []; customerId = null; text.clear(); pending = null; receiptId = null; state = null;
      }
    });
  }

  Future<void> check() async {
    if (busy || blocked || receiptId == null) return;
    final current = ++generation;
    final path = '$base/message-receipts/$receiptId';
    setState(() { busy = true; failed = false; });
    try {
      final result = await api.request('GET', path) as Map<String, dynamic>;
      if (!mounted || current != generation) return;
      setState(() => state = result['state'] as String);
    } catch (error) {
      if (mounted && current == generation) handleError(error);
    }
    if (mounted && current == generation) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final status = switch (state) { 'pending' => l.simulationPending, 'processed' => l.simulationProcessed,
      'rejected' => l.simulationRejected, 'failed' => l.simulationFailed, _ => l.actionError };
    return Scaffold(appBar: AppBar(title: Text(l.simulationTitle), leading: IconButton(
      tooltip: l.channelsTitle, icon: const Icon(Icons.arrow_back), onPressed: () => context.go('/channels/${widget.tenantId}'))),
      body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 720),
        child: ListView(padding: const EdgeInsets.all(24), children: [
          Text(l.simulationHint), const SizedBox(height: 16),
          if (busy) const LinearProgressIndicator(),
          if (failed) Semantics(liveRegion: true, child: Text(pending != null && receiptId == null ? l.simulationUncertain : l.actionError)),
          if (!busy && !ready && pending == null && !blocked) TextButton(onPressed: () => load(), child: Text(l.retry)),
          if (ready && pending == null) Form(key: form, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (customers.isEmpty) Text(l.noCustomers),
            DropdownButtonFormField<String>(initialValue: customerId, isExpanded: true,
              decoration: InputDecoration(labelText: l.customers),
              items: customers.map((c) => DropdownMenuItem(value: c['id'] as String, child: Text(c['displayName'] as String, overflow: TextOverflow.ellipsis))).toList(),
              onChanged: busy ? null : (value) => setState(() => customerId = value),
              validator: (value) => value == null ? l.invalidField : null),
            if (next != null) TextButton(onPressed: busy ? null : () => load(more: true), child: Text(l.loadMore)),
            const SizedBox(height: 16),
            TextFormField(controller: text, enabled: !busy, maxLength: 4096, minLines: 3, maxLines: 6,
              decoration: InputDecoration(labelText: l.simulationMessage),
              validator: (value) => value == null || value.trim().isEmpty || value.length > 4096 ? l.invalidField : null),
            FilledButton(onPressed: busy || customers.isEmpty ? null : submit, child: Text(l.simulationSend)),
          ])),
          if (pending != null && receiptId == null && !busy && !blocked) FilledButton(onPressed: submit, child: Text(l.simulationRetry)),
          if (receiptId != null) ...[
            Semantics(liveRegion: true, child: Text(status)),
            SelectableText(receiptId!),
            OutlinedButton(onPressed: busy ? null : check, child: Text(l.simulationCheck)),
            if (terminal) TextButton(onPressed: busy ? null : () {
              pending = null; receiptId = null; state = null; text.clear(); load();
            }, child: Text(l.simulationNew)),
            TextButton(onPressed: () => context.go('/conversations/${widget.tenantId}'), child: Text(l.conversations)),
          ],
        ]))),
    );
  }
}
