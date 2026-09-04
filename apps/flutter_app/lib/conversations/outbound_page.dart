import 'dart:async';
import 'package:flutter/material.dart';
import '../channels/simulation_page.dart' show simulationId;
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';

class OutboundPage extends StatefulWidget {
  const OutboundPage({super.key, required this.tenantId, required this.conversationId, required this.channelId, required this.api});
  final String tenantId, conversationId, channelId;
  final IdentityApi api;
  @override
  State<OutboundPage> createState() => _OutboundPageState();
}

class _OutboundPageState extends State<OutboundPage> {
  final text = TextEditingController();
  Map<String, Object?>? pending;
  String? intentId;
  String? receiptState;
  bool busy = true, ready = false, failed = false, blocked = false, waiting = false;
  int generation = 0, pollCount = 0;
  Timer? retryTimer, pollTimer;
  @override
  void initState() { super.initState(); load(); }
  @override
  void didUpdateWidget(covariant OutboundPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tenantId != widget.tenantId || oldWidget.conversationId != widget.conversationId || oldWidget.channelId != widget.channelId || oldWidget.api != widget.api) {
      retryTimer?.cancel(); pollTimer?.cancel(); waiting = false; pending = null; intentId = null; receiptState = null; pollCount = 0; text.clear(); load();
    }
  }
  @override
  void dispose() { retryTimer?.cancel(); pollTimer?.cancel(); text.dispose(); super.dispose(); }

  void schedulePoll() {
    pollTimer?.cancel();
    if (receiptState != 'pending' || pollCount >= 15 || waiting || blocked) return;
    pollTimer = Timer(const Duration(seconds: 1), () {
      if (!mounted || receiptState != 'pending') return;
      pollCount++;
      submit(check: true, automatic: true);
    });
  }

  Future<void> load() async {
    final current = ++generation;
    final path = '/tenants/${widget.tenantId}/channels';
    setState(() { busy = true; ready = false; failed = false; blocked = false; });
    try {
      if (!widget.api.authenticated) await widget.api.refresh();
      final rows = await widget.api.request('GET', path) as List;
      if (!mounted || current != generation) return;
      final eligible = rows.cast<Map<String, dynamic>>().any((c) => c['id'] == widget.channelId && c['mode'] == 'mock' && c['channelType'] == 'whatsapp' && c['status'] == 'active');
      setState(() { ready = eligible; blocked = !eligible; });
    } catch (_) {
      if (mounted && current == generation) setState(() => failed = true);
    }
    if (mounted && current == generation) setState(() => busy = false);
  }

  Future<void> submit({bool check = false, bool automatic = false}) async {
    if (busy || waiting || blocked || !ready) return;
    if (!check && pending == null) {
      if (text.text.trim().isEmpty || text.text.runes.length > 4096) return;
      pending = Map.unmodifiable({'requestId': simulationId(), 'text': text.text});
    }
    if (check && intentId == null) return;
    final current = ++generation;
    final path = check ? '/tenants/${widget.tenantId}/outbound-intents/$intentId' : '/tenants/${widget.tenantId}/conversations/${widget.conversationId}/mock-outbound-intents';
    setState(() { busy = true; failed = false; });
    try {
      final result = await widget.api.request(check ? 'GET' : 'POST', path, check ? null : pending, false) as Map<String, dynamic>;
      if (!mounted || current != generation) return;
      const states = {'stored', 'pending', 'mock_accepted', 'rejected', 'failed'};
      if (!states.contains(result['state']) || result['intentId'] is! String || (result['intentId'] as String).isEmpty || (check && result['intentId'] != intentId)) throw const FormatException('Invalid receipt');
      setState(() { intentId = result['intentId'] as String; receiptState = result['state'] as String; text.clear(); });
      if (receiptState == 'pending') {
        schedulePoll();
      } else {
        pollTimer?.cancel();
      }
    } catch (error) {
      if (!mounted || current != generation) return;
      setState(() {
        failed = true;
        if (error is ApiFailure && [400, 401, 403, 404, 409].contains(error.status)) { blocked = true; intentId = null; }
        if (error is ApiFailure && error.status == 429) {
          waiting = true;
          retryTimer?.cancel();
          retryTimer = Timer(Duration(seconds: error.retryAfterSeconds ?? 60), () {
            if (mounted && current == generation) {
              setState(() => waiting = false);
              if (automatic) schedulePoll();
            }
          });
        }
      });
    }
    if (mounted && current == generation) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Scaffold(appBar: AppBar(title: Text(l.outboundTitle)), body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 640), child: ListView(padding: const EdgeInsets.all(24), children: [
      Text(l.outboundHint), const SizedBox(height: 16),
      if (busy) const LinearProgressIndicator(),
      if (blocked) Text(l.outboundBlocked),
      if (waiting) Semantics(liveRegion: true, child: Text(l.outboundLimited)),
      if (failed && !blocked && !waiting) Text(l.actionError),
      if (!ready && !busy && !blocked) TextButton(onPressed: load, child: Text(l.retry)),
      if (ready && !blocked) ...[
        if (pending == null) TextField(controller: text, enabled: !busy, maxLength: 4096, minLines: 3, maxLines: 8, decoration: InputDecoration(labelText: l.simulationMessage)),
        if (intentId == null) FilledButton(onPressed: busy || waiting ? null : () => submit(), child: Text(pending == null ? l.outboundStore : l.simulationRetry)),
        if (intentId != null) ...[
          Semantics(liveRegion: true, child: Text(switch (receiptState) {
            'pending' => l.outboundPending,
            'mock_accepted' => l.outboundAccepted,
            'rejected' => l.outboundRejected,
            'failed' => l.outboundFailed,
            _ => l.outboundStored,
          })),
          SelectableText(intentId!),
          TextButton(onPressed: busy || waiting ? null : () => submit(check: true), child: Text(l.simulationCheck)),
          TextButton(onPressed: busy || waiting ? null : () => setState(() { retryTimer?.cancel(); pollTimer?.cancel(); pending = null; intentId = null; receiptState = null; pollCount = 0; failed = false; text.clear(); }), child: Text(l.outboundNew)),
        ],
      ],
    ]))));
  }
}
