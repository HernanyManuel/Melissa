import 'dart:async';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';
import 'outbound_page.dart';
import 'human_controls.dart';
import 'inbox_events.dart';

typedef InboxEventSource = Stream<InboxEvent> Function(String tenantId, String? after);

class ConversationsPage extends StatefulWidget {
  const ConversationsPage({
    super.key, required this.tenantId, this.api,
    this.realtimeEnabled = true, this.eventSource,
  });
  final String tenantId;
  final IdentityApi? api;
  final bool realtimeEnabled;
  final InboxEventSource? eventSource;
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
  int streamGeneration = 0;
  int reconnectAttempts = 0;
  int refreshGeneration = 0;
  int refreshAttempts = 0;
  bool streamRevoked = false;
  String? eventCursor;
  StreamSubscription<InboxEvent>? inboxSubscription;
  Timer? reconnectTimer;
  Timer? updateTimer;
  Timer? refreshRetryTimer;
  final Set<String> changedConversations = {};
  String get base => '/tenants/${widget.tenantId}/conversations';

  @override
  void initState() {
    super.initState();
    api = widget.api ?? IdentityApi();
    load();
    _connectInbox();
  }
  @override
  void didUpdateWidget(covariant ConversationsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tenantId != widget.tenantId) {
      _stopInbox();
      streamRevoked = false;
      search.clear(); searchQuery = '';
      messageGeneration++;
      conversations = []; messages = []; selected = null;
      conversationNext = null; messageNext = null;
      reading = false; messageError = false;
      load();
      _connectInbox();
    }
  }
  @override
  void dispose() {
    _stopInbox();
    search.dispose();
    if (widget.api == null) api.dispose();
    super.dispose();
  }


  void _stopInbox() {
    streamGeneration++;
    refreshGeneration++;
    inboxSubscription?.cancel();
    inboxSubscription = null;
    reconnectTimer?.cancel();
    reconnectTimer = null;
    updateTimer?.cancel();
    updateTimer = null;
    refreshRetryTimer?.cancel();
    refreshRetryTimer = null;
    refreshAttempts = 0;
    changedConversations.clear();
    eventCursor = null;
    reconnectAttempts = 0;
  }

  void _revokeInbox() {
    _stopInbox();
    streamRevoked = true;
    if (!mounted) return;
    setState(() {
      conversations = [];
      selected = null;
      messages = [];
      conversationNext = null;
      messageNext = null;
      messageGeneration++;
      listGeneration++;
      listError = true;
      loading = false;
      reading = false;
    });
  }

  void _connectInbox() {
    if (!mounted || !widget.realtimeEnabled || streamRevoked) return;
    final version = streamGeneration;
    final events = widget.eventSource?.call(widget.tenantId, eventCursor) ??
        watchInboxEvents(api, widget.tenantId, after: eventCursor);
    inboxSubscription = events.listen((event) {
      if (!mounted || version != streamGeneration || streamRevoked) return;
      if (!validInboxCursor(event.sequence) ||
          (eventCursor != null &&
              BigInt.parse(event.sequence) <= BigInt.parse(eventCursor!))) return;
      eventCursor = event.sequence;
      reconnectAttempts = 0;
      changedConversations.add(event.conversationId);
      _scheduleInboxRefresh();
    }, onError: (Object error) {
      if (version != streamGeneration || !mounted) return;
      if (error is ApiFailure && [401, 403, 404].contains(error.status)) {
        _revokeInbox();
      } else {
        _scheduleReconnect(version);
      }
    }, onDone: () => _scheduleReconnect(version), cancelOnError: true);
  }

  void _scheduleReconnect(int version) {
    if (!mounted || version != streamGeneration || streamRevoked ||
        !widget.realtimeEnabled || reconnectTimer != null) return;
    final seconds = 1 << (reconnectAttempts < 4 ? reconnectAttempts : 4);
    if (reconnectAttempts < 4) reconnectAttempts++;
    reconnectTimer = Timer(Duration(seconds: seconds), () {
      reconnectTimer = null;
      if (mounted && version == streamGeneration) _connectInbox();
    });
  }

  void _scheduleInboxRefresh() {
    if (!mounted || changedConversations.isEmpty || updateTimer != null) return;
    updateTimer = Timer(const Duration(milliseconds: 200), () {
      updateTimer = null;
      _refreshFromInboxEvents();
    });
  }

  /// SSE carries only IDs. Re-fetch through tenant-scoped REST before rendering.
  /// Preserve selection and loaded page depth without repopulating stale tenants.
  Future<void> _refreshFromInboxEvents() async {
    if (!mounted || changedConversations.isEmpty || streamRevoked) return;
    if (loading) return; // load() retries buffered events on completion.
    final affected = Set<String>.of(changedConversations);
    changedConversations.clear();
    final refreshVersion = ++refreshGeneration;
    final streamVersion = streamGeneration;
    final listVersion = listGeneration;
    final selectedId = selected?['id'] as String?;
    final messageVersion = messageGeneration;
    final tenant = widget.tenantId;
    final searchAtStart = searchQuery;
    final listPages = ((conversations.length + 49) ~/ 50).clamp(1, 10);
    final messagePages = ((messages.length ~/ 50) + 1).clamp(1, 10);
    try {
      final updated = <Map<String, dynamic>>[];
      String? after;
      for (var i = 0; i < listPages; i++) {
        final params = <String, String>{
          if (searchAtStart.isNotEmpty) 'q': searchAtStart,
          if (after != null) 'after': after,
        };
        final suffix = params.isEmpty ? '' : '?${Uri(queryParameters: params).query}';
        final result = await api.request('GET', '$base$suffix') as Map<String, dynamic>;
        updated.addAll((result['items'] as List).cast<Map<String, dynamic>>());
        after = result['next'] as String?;
        if (after == null) break;
      }
      final newNext = after;
      Map<String, dynamic>? refreshedSelection;
      if (selectedId != null) {
        for (final row in updated) {
          if (row['id'] == selectedId) {
            refreshedSelection = row;
            break;
          }
        }
      }
      final latestMessages = <Map<String, dynamic>>[];
      String? nextMessage;
      if (selectedId != null && affected.contains(selectedId)) {
        for (var i = 0; i < messagePages; i++) {
          final endpoint = '$base/$selectedId/messages'
              '${nextMessage == null ? '' : '?after=$nextMessage'}';
          final page = await api.request('GET', endpoint) as Map<String, dynamic>;
          latestMessages.addAll((page['items'] as List).cast<Map<String, dynamic>>());
          nextMessage = page['next'] as String?;
          if (nextMessage == null) break;
        }
      }
      if (!mounted || streamVersion != streamGeneration ||
          refreshVersion != refreshGeneration ||
          listVersion != listGeneration || searchAtStart != searchQuery ||
          tenant != widget.tenantId) return;
      refreshAttempts = 0;
      refreshRetryTimer?.cancel();
      refreshRetryTimer = null;
      setState(() {
        conversations = updated;
        conversationNext = newNext;
        if (selectedId != null && selected?['id'] == selectedId) {
          if (refreshedSelection != null) selected = refreshedSelection;
          if (affected.contains(selectedId) && messageGeneration == messageVersion) {
            messages = latestMessages;
            messageNext = nextMessage;
            messageError = false;
          }
        }
      });
    } catch (error) {
      if (!mounted || streamVersion != streamGeneration || tenant != widget.tenantId) return;
      if (error is ApiFailure && [401, 403, 404].contains(error.status)) {
        _revokeInbox();
      } else if (refreshVersion == refreshGeneration) {
        // Do not advance the displayed view permanently past an unrefreshed event.
        changedConversations.addAll(affected);
        if (refreshRetryTimer == null) {
          final seconds = 1 << (refreshAttempts < 4 ? refreshAttempts : 4);
          if (refreshAttempts < 4) refreshAttempts++;
          refreshRetryTimer = Timer(Duration(seconds: seconds), () {
            refreshRetryTimer = null;
            _scheduleInboxRefresh();
          });
        }
      }
    } finally {
      if (mounted && refreshRetryTimer == null &&
          changedConversations.isNotEmpty) _scheduleInboxRefresh();
    }
  }

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
    if (mounted && generation == listGeneration) {
      setState(() => loading = false);
      if (changedConversations.isNotEmpty) _scheduleInboxRefresh();
    }
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

  void applyConversationControl(Map<String, dynamic> update) {
    if (!mounted || selected?['id'] != update['id']) return;
    setState(() {
      selected = update;
      conversations = conversations.map((row) => row['id'] == update['id'] ? update : row).toList();
    });
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
      if (selected!['mode'] is String)
        ConversationHumanControls(
          key: ValueKey('${widget.tenantId}/${selected!['id']}'),
          tenantId: widget.tenantId,
          conversation: selected!,
          api: api,
          onChanged: applyConversationControl,
          onRevoked: () => load(),
        )
      else Padding(padding: const EdgeInsets.all(12), child: Text(l.readOnlyConversation)),
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
