import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';
import 'outbound_page.dart';

class ConversationsPage extends StatefulWidget {
  const ConversationsPage({super.key, required this.tenantId, this.api});
  final String tenantId;
  final IdentityApi? api;
  @override
  State<ConversationsPage> createState() => _ConversationsPageState();
}

class _ConversationsPageState extends State<ConversationsPage> {
  late final IdentityApi api;
  final search = TextEditingController();
  String searchQuery = '';
  List<Map<String, dynamic>> conversations = [];
  List<Map<String, dynamic>> messages = [];
  Map<String, dynamic>? selected;
  String? conversationNext;
  String? messageNext;
  bool loading = true;
  bool reading = false;
  bool listError = false;
  bool messageError = false;
  int listGeneration = 0;
  int messageGeneration = 0;
  String get base => '/tenants/${widget.tenantId}/conversations';

  @override
  void initState() { super.initState(); api = widget.api ?? IdentityApi(); load(); }
  @override
  void didUpdateWidget(covariant ConversationsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tenantId != widget.tenantId) {
      search.clear(); searchQuery = '';
      messageGeneration++;
      conversations = []; messages = []; selected = null;
      conversationNext = null; messageNext = null;
      reading = false; messageError = false;
      load();
    }
  }
  @override
  void dispose() { search.dispose(); if (widget.api == null) api.dispose(); super.dispose(); }

  Future<void> load({bool more = false}) async {
    final generation = ++listGeneration;
    final params = <String, String>{if (searchQuery.isNotEmpty) 'q': searchQuery,
      if (more && conversationNext != null) 'after': conversationNext!};
    final path = '$base${params.isEmpty ? '' : '?${Uri(queryParameters: params).query}'}';
    setState(() { loading = true; listError = false;
      if (!more) { conversations = []; conversationNext = null; selected = null; messages = [];
        messageGeneration++; reading = false; messageNext = null; messageError = false; }
    });
    try {
      if (!api.authenticated) await api.refresh();
      final page = await api.request('GET', path) as Map<String, dynamic>;
      if (!mounted || generation != listGeneration) return;
      final rows = (page['items'] as List).cast<Map<String, dynamic>>();
      setState(() { conversations = more ? [...conversations, ...rows] : rows; conversationNext = page['next'] as String?; });
    } catch (_) {
      if (mounted && generation == listGeneration) {
        setState(() {
        listError = true;
        // A refresh may reveal revoked access. Do not keep sensitive cached data visible.
        conversations = []; selected = null; messages = []; conversationNext = null;
        messageGeneration++; reading = false; messageNext = null;
      });
      }
    }
    if (mounted && generation == listGeneration) setState(() => loading = false);
  }

  Future<void> open(Map<String, dynamic> conversation, {bool more = false}) async {
    final generation = ++messageGeneration;
    final path = '$base/${conversation['id']}/messages${more && messageNext != null ? '?after=$messageNext' : ''}';
    setState(() {
      selected = conversation; reading = true; messageError = false;
      if (!more) { messages = []; messageNext = null; }
    });
    try {
      final page = await api.request('GET', path) as Map<String, dynamic>;
      if (!mounted || generation != messageGeneration) return;
      setState(() {
        final rows = (page['items'] as List).cast<Map<String, dynamic>>();
        messages = more ? [...messages, ...rows] : rows;
        messageNext = page['next'] as String?;
      });
    } catch (_) {
      if (mounted && generation == messageGeneration) setState(() { messages = []; messageNext = null; messageError = true; });
    }
    if (mounted && generation == messageGeneration) setState(() => reading = false);
  }

  Widget errorPanel(VoidCallback retry) {
    final l = AppLocalizations.of(context)!;
    return Padding(padding: const EdgeInsets.all(16), child: Column(children: [
      Text(l.actionError), TextButton(onPressed: retry, child: Text(l.retry)),
    ]));
  }

  Widget conversationList() {
    final l = AppLocalizations.of(context)!;
    return Column(children: [
      ListTile(title: Text(l.conversations), trailing: IconButton(tooltip: l.retry, onPressed: loading ? null : () => load(), icon: const Icon(Icons.refresh))),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: TextField(
        controller: search, maxLength: 80, textInputAction: TextInputAction.search,
        decoration: InputDecoration(labelText: l.conversationSearch, suffixIcon: IconButton(
          tooltip: l.conversationClear, icon: const Icon(Icons.clear), onPressed: () { search.clear(); searchQuery = ''; load(); })),
        onSubmitted: (_) { searchQuery = search.text.trim(); load(); },
      )),
      TextButton.icon(onPressed: () { searchQuery = search.text.trim(); load(); }, icon: const Icon(Icons.search), label: Text(l.conversationSearchAction)),
      if (loading) const LinearProgressIndicator(),
      if (listError) errorPanel(() => load()),
      if (!loading && !listError && conversations.isEmpty) Padding(padding: const EdgeInsets.all(24), child: Text(searchQuery.isEmpty ? l.noConversations : l.conversationNoMatches)),
      Expanded(child: ListView(children: [
        for (final c in conversations) ListTile(
          selected: selected?['id'] == c['id'],
          leading: const Icon(Icons.chat_bubble_outline),
          title: Text(c['customer']['displayName'] as String),
          subtitle: Text('${c['channelConnection']['displayName']} · ${c['channelConnection']['mode'] == 'mock' ? l.testChannel : l.conversations}'),
          onTap: () => open(c),
        ),
        if (conversationNext != null) TextButton(onPressed: loading ? null : () => load(more: true), child: Text(l.loadMore)),
      ])),
    ]);
  }

  Widget history({required bool narrow}) {
    final l = AppLocalizations.of(context)!;
    if (selected == null) return Center(child: Text(l.selectConversation));
    return Column(children: [
      ListTile(
        leading: narrow ? IconButton(tooltip: l.conversations, icon: const Icon(Icons.arrow_back), onPressed: () => setState(() { messageGeneration++; selected = null; messages = []; reading = false; })) : null,
        title: Text(selected!['customer']['displayName'] as String),
        trailing: IconButton(tooltip: l.retry, onPressed: reading ? null : () => open(selected!), icon: const Icon(Icons.refresh)),
      ),
      Padding(padding: const EdgeInsets.all(12), child: Text(l.readOnlyConversation)),
      if (selected!['channelConnection']['mode'] == 'mock' && selected!['channelConnectionId'] is String)
        TextButton.icon(icon: const Icon(Icons.science_outlined), label: Text(l.outboundTitle), onPressed: reading || messageError ? null : () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => OutboundPage(tenantId: widget.tenantId, conversationId: selected!['id'] as String, channelId: selected!['channelConnectionId'] as String, api: api)))),
      if (reading) const LinearProgressIndicator(),
      if (messageError) errorPanel(() => open(selected!)),
      if (!reading && !messageError && messages.isEmpty) Padding(padding: const EdgeInsets.all(24), child: Text(l.noMessages)),
      Expanded(child: ListView(padding: const EdgeInsets.all(16), children: [
        for (final message in messages) Align(alignment: message['direction'] == 'inbound' ? Alignment.centerLeft : Alignment.centerRight,
          child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 600), child: Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SelectableText(message['contentText'] as String),
            const SizedBox(height: 8),
            Text(timestamp(message['createdAt'] as String), style: Theme.of(context).textTheme.labelSmall),
          ])))),
        ),
        if (messageNext != null) TextButton(onPressed: reading ? null : () => open(selected!, more: true), child: Text(l.loadMore)),
      ])),
    ]);
  }

  String timestamp(String value) {
    final date = DateTime.tryParse(value)?.toLocal();
    if (date == null) return '';
    final material = MaterialLocalizations.of(context);
    return '${material.formatShortDate(date)} ${material.formatTimeOfDay(TimeOfDay.fromDateTime(date))}';
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Scaffold(appBar: AppBar(title: Text(l.conversations), leading: IconButton(tooltip: l.account, icon: const Icon(Icons.arrow_back), onPressed: () => context.go('/account'))),
      body: LayoutBuilder(builder: (context, constraints) {
        if (constraints.maxWidth < 760) return selected == null ? conversationList() : history(narrow: true);
        return Row(children: [SizedBox(width: 320, child: conversationList()), const VerticalDivider(width: 1), Expanded(child: history(narrow: false))]);
      }),
    );
  }
}
