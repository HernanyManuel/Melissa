import 'package:flutter/material.dart';
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';

/// Read-only, tenant-authorized profile. Never calls a sending endpoint.
class ConversationCustomerContext extends StatefulWidget {
  const ConversationCustomerContext({
    super.key,
    required this.tenantId,
    required this.conversationId,
    required this.api,
  });
  final String tenantId;
  final String conversationId;
  final IdentityApi api;

  @override
  State<ConversationCustomerContext> createState() => _ConversationCustomerContextState();
}

class _ConversationCustomerContextState extends State<ConversationCustomerContext> {
  Map<String, dynamic>? customer;
  bool loading = false;
  bool failed = false;
  int generation = 0;

  @override
  void initState() {
    super.initState();
    load();
  }

  @override
  void didUpdateWidget(covariant ConversationCustomerContext oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.tenantId != oldWidget.tenantId ||
        widget.conversationId != oldWidget.conversationId) {
      generation++;
      customer = null;
      failed = false;
      load();
    }
  }

  @override
  void dispose() {
    generation++;
    super.dispose();
  }

  Future<void> load() async {
    final version = ++generation;
    setState(() { loading = true; failed = false; customer = null; });
    try {
      final result = await widget.api.request(
        'GET',
        '/tenants/${widget.tenantId}/conversations/${widget.conversationId}/customer',
      ) as Map<String, dynamic>;
      final item = result['item'];
      if (item is! Map<String, dynamic> ||
          item['id'] is! String || item['displayName'] is! String ||
          item['phoneE164'] is! String || item['language'] is! String) {
        throw const FormatException('Invalid customer context');
      }
      if (!mounted || version != generation) return;
      setState(() => customer = item);
    } catch (_) {
      if (mounted && version == generation) {
        setState(() { failed = true; customer = null; });
      }
    } finally {
      if (mounted && version == generation) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return ExpansionTile(
      key: const Key('inbox-customer-context'),
      title: Text(l.inboxCustomerProfile),
      leading: const Icon(Icons.person_outline),
      children: [
        if (loading) const LinearProgressIndicator(),
        if (failed) TextButton(
          onPressed: loading ? null : load,
          child: Text(l.retry),
        ),
        if (customer != null) Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(customer!['displayName'] as String),
            Text('${l.inboxCustomerPhone}: ${customer!['phoneE164']}'),
            if (customer!['email'] is String)
              Text('${l.inboxCustomerEmail}: ${customer!['email']}'),
            Text('${l.inboxCustomerLanguage}: ${customer!['language']}'),
            Text('${l.inboxCustomerConsent}: ${customer!['whatsappOptInStatus'] ?? 'unknown'}'),
            Text('${l.inboxCustomerMarketingConsent}: ${customer!['marketingConsentStatus'] ?? 'unknown'}'),
            if (customer!['notes'] is String &&
                (customer!['notes'] as String).isNotEmpty)
              SelectableText('${l.inboxCustomerNotes}: ${customer!['notes']}'),
          ]),
        ),
      ],
    );
  }
}
