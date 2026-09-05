import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';

class ChannelsPage extends StatefulWidget {
  const ChannelsPage({super.key, required this.tenantId, this.api});
  final String tenantId;
  final IdentityApi? api;
  @override
  State<ChannelsPage> createState() => _ChannelsPageState();
}

class _ChannelsPageState extends State<ChannelsPage> {
  late final IdentityApi api;
  final name = TextEditingController();
  final form = GlobalKey<FormState>();
  List<Map<String, dynamic>> rows = [];
  bool busy = true, ready = false, failed = false, uncertain = false;
  int generation = 0;

  @override
  void initState() { super.initState(); api = widget.api ?? IdentityApi(); load(); }
  @override
  void didUpdateWidget(covariant ChannelsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tenantId != widget.tenantId) { name.clear(); load(); }
  }
  @override
  void dispose() { name.dispose(); if (widget.api == null) api.dispose(); super.dispose(); }

  Future<void> load() async {
    final current = ++generation;
    final path = '/tenants/${widget.tenantId}/channels';
    setState(() { busy = true; ready = false; failed = false; uncertain = false; rows = []; });
    try {
      if (!api.authenticated) await api.refresh();
      final result = (await api.request('GET', path) as List).cast<Map<String, dynamic>>();
      if (!mounted || current != generation) return;
      setState(() { rows = result; ready = true; });
    } catch (_) {
      if (mounted && current == generation) setState(() => failed = true);
    }
    if (mounted && current == generation) setState(() => busy = false);
  }

  Future<void> mutate(String suffix, Map<String, Object?> body) async {
    if (busy || !ready) return;
    final current = ++generation;
    final path = '/tenants/${widget.tenantId}/channels$suffix';
    setState(() { busy = true; failed = false; uncertain = false; });
    try {
      await api.request('POST', path, body);
      if (!mounted || current != generation) return;
      name.clear();
      await load();
    } catch (_) {
      if (mounted && current == generation) {
        setState(() { busy = false; ready = false; failed = true; uncertain = true; rows = []; });
      }
    }
  }

  Future<void> disconnect(Map<String, dynamic> channel) async {
    if (busy || !ready) return;
    final current = generation;
    final l = AppLocalizations.of(context)!;
    final confirmed = await showDialog<bool>(context: context, builder: (context) => AlertDialog(
      title: Text(l.channelDisconnect), content: Text(l.channelDisconnectHint),
      actions: [TextButton(onPressed: () => Navigator.pop(context, false), child: Text(l.close)),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(l.channelDisconnect))],
    ));
    if (!mounted || generation != current || confirmed != true) return;
    await mutate('/${channel['id']}/disconnect', {});
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Scaffold(appBar: AppBar(title: Text(l.channelsTitle),
      leading: IconButton(tooltip: l.account, icon: const Icon(Icons.arrow_back), onPressed: () => context.go('/account')),
      actions: [IconButton(tooltip: l.retry, onPressed: busy ? null : load, icon: const Icon(Icons.refresh))]),
      body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 900),
        child: ListView(padding: const EdgeInsets.all(24), children: [
          Text(l.channelsHint), const SizedBox(height: 16),
          if (busy) const LinearProgressIndicator(),
          if (failed) Semantics(liveRegion: true, child: Text(uncertain ? l.channelUncertain : l.actionError)),
          if (ready) ...[
            Form(key: form, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              TextFormField(controller: name, enabled: !busy && rows.length < 100, maxLength: 160,
                decoration: InputDecoration(labelText: l.channelName),
                validator: (value) => value == null || value.trim().isEmpty || value.trim().length > 160 ? l.invalidField : null),
              FilledButton.icon(onPressed: busy || rows.length >= 100 ? null : () {
                if (form.currentState!.validate()) mutate('/mock', {'displayName': name.text.trim()});
              }, icon: const Icon(Icons.add), label: Text(l.channelCreate)),
            ])),
            const SizedBox(height: 16),
            if (rows.length >= 100) Text(l.channelLimit),
            if (rows.isEmpty) Text(l.channelsEmpty),
            for (final row in rows) Card(child: Padding(padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(row['displayName'] as String, style: Theme.of(context).textTheme.titleMedium),
                Text(row['mode'] == 'mock' ? l.testChannel : l.channelLive),
                Text(row['status'] == 'active' ? l.channelActive : row['status'] == 'disconnected' ? l.channelDisconnected : l.channelOtherStatus),
                if (row['mode'] == 'mock' && row['status'] == 'active') OutlinedButton(
                  onPressed: busy ? null : () => context.go('/channels/${widget.tenantId}/${row['id']}/simulate'), child: Text(l.simulationTitle)),
                if (row['mode'] == 'mock' && row['status'] == 'active') OutlinedButton(
                  onPressed: busy ? null : () => disconnect(row), child: Text(l.channelDisconnect)),
              ]))),
          ],
        ]))),
    );
  }
}
