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
  List<Map<String, dynamic>> relatedConversations = [];
  bool hasMoreRelated = false;
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
      relatedConversations = [];
      hasMoreRelated = false;
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
    setState(() {
      loading = true; failed = false; customer = null;
      relatedConversations = []; hasMoreRelated = false;
    });
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
      final related = result['relatedConversations'];
      if (related != null &&
          (related is! Map<String, dynamic> ||
              related['items'] is! List ||
              related['hasMore'] is! bool)) {
        throw const FormatException('Invalid related conversation context');
      }
      final rows = related == null
          ? <Map<String, dynamic>>[]
          : (related['items'] as List).cast<Map<String, dynamic>>();
      if (rows.length > 5 || rows.any((row) =>
          row['id'] is! String || row['channelName'] is! String ||
          row['status'] is! String || row['lastMessageAt'] is! String ||
          row['id'] == widget.conversationId)) {
        throw const FormatException('Invalid related conversation summary');
      }
      if (!mounted || version != generation) return;
      setState(() {
        customer = item;
        relatedConversations = rows;
        hasMoreRelated = related?['hasMore'] == true;
      });
    } catch (_) {
      if (mounted && version == generation) {
        setState(() {
          failed = true; customer = null;
          relatedConversations = []; hasMoreRelated = false;
        });
      }
    } finally {
      if (mounted && version == generation) setState(() => loading = false);
    }
  }

  String _relatedSummary(BuildContext context, AppLocalizations l,
      Map<String, dynamic> row) {
    final status = switch (row['status']) {
      'open' => l.inboxStatusOpen,
      'closed' => l.inboxStatusClosed,
      'archived' => l.inboxStatusArchived,
      _ => row['status'] as String,
    };
    final date = DateTime.tryParse(row['lastMessageAt'] as String)?.toLocal();
    if (date == null) return status;
    final local = MaterialLocalizations.of(context);
    return '$status · ${local.formatShortDate(date)}';
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
            if (relatedConversations.isNotEmpty || hasMoreRelated) ...[
              const SizedBox(height: 12),
              Text(l.inboxCustomerOtherConversations,
                style: Theme.of(context).textTheme.titleSmall),
              SizedBox(
                height: 152,
                child: ListView(
                  primary: false,
                  children: [
                    for (final related in relatedConversations)
                      ListTile(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.forum_outlined),
                        title: Text(related['channelName'] as String),
                        subtitle: Text(_relatedSummary(context, l, related)),
                      ),
                  ],
                ),
              ),
              if (hasMoreRelated) Text(l.inboxCustomerMoreConversations),
            ],
          ]),
        ),
      ],
    );
  }
}
