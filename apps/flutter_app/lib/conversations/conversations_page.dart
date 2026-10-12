import 'dart:async';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';
import 'outbound_page.dart';
import 'human_controls.dart';
import 'internal_notes.dart';
import 'customer_context.dart';
import 'conversation_tags.dart';
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
  String? selectedTagId;
  bool unreadOnly = false;
  String assignmentFilter = 'all';
  String statusFilter = 'all';
  String channelModeFilter = 'all';
  String controlModeFilter = 'all';
  String sortFilter = 'id';
  String activityWindow = 'all';
  String? activitySince;
  String? selectedChannelId;
  List<Map<String, dynamic>> channelOptions = [];
  String? channelOptionsNext;
  bool channelOptionsOpen = false;
  bool channelOptionsLoading = false;
  bool channelOptionsError = false;
  int channelOptionsGeneration = 0;
  List<Map<String, dynamic>> availableTags = [];
  bool tagFilterOpen = false;
  bool tagsLoading = false;
  bool tagsError = false;
  int tagsGeneration = 0;
  List<Map<String, dynamic>> conversations = [];
  List<Map<String, dynamic>> messages = [];
  Map<String, dynamic>? selected;
  String? conversationNext;
  String? messageNext;
  bool loading = true;
  bool reading = false;
  bool listError = false;
  bool messageError = false;
  bool markingRead = false;
  bool readReceiptError = false;
  int? tenantUnreadConversations;
  int? tenantUnreadMessages;
  int summaryGeneration = 0;
  int listGeneration = 0;
  int messageGeneration = 0;
  int streamGeneration = 0;
  int reconnectAttempts = 0;
  int refreshGeneration = 0;
  int refreshAttempts = 0;
  int? activeRefreshStream;
  bool streamRevoked = false;
  String? eventCursor;
  String? pendingAppliedCursor;
  StreamSubscription<InboxEvent>? inboxSubscription;
  Timer? reconnectTimer;
  Timer? updateTimer;
  Timer? refreshRetryTimer;
  final Set<String> changedConversations = {};
  final Set<String> newInboundAlerts = {};
  String get base => '/tenants/${widget.tenantId}/conversations';

  @override
  void initState() {
    super.initState();
    api = widget.api ?? IdentityApi();
    _startInbox();
  }
  @override
  void didUpdateWidget(covariant ConversationsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tenantId != widget.tenantId) {
      _stopInbox();
      streamRevoked = false;
      search.clear(); searchQuery = '';
      tagsGeneration++; availableTags = []; selectedTagId = null;
      channelOptionsGeneration++; channelOptions = []; selectedChannelId = null;
      channelOptionsNext = null; channelOptionsOpen = false;
      channelOptionsLoading = false; channelOptionsError = false;
      unreadOnly = false; assignmentFilter = 'all'; statusFilter = 'all'; channelModeFilter = 'all'; controlModeFilter = 'all'; sortFilter = 'id'; activityWindow = 'all'; activitySince = null;
      tagFilterOpen = false; tagsLoading = false; tagsError = false;
      messageGeneration++;
      conversations = []; messages = []; selected = null;
      newInboundAlerts.clear();
      conversationNext = null; messageNext = null;
      reading = false; messageError = false;
      markingRead = false; readReceiptError = false;
      _startInbox();
    }
  }
  @override
  void dispose() {
    _stopInbox();
    tagsGeneration++;
    channelOptionsGeneration++;
    search.dispose();
    if (widget.api == null) api.dispose();
    super.dispose();
  }


  void _stopInbox() {
    streamGeneration++;
    summaryGeneration++;
    tenantUnreadConversations = null;
    tenantUnreadMessages = null;
    refreshGeneration++;
    activeRefreshStream = null;
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
    newInboundAlerts.clear();
    eventCursor = null;
    pendingAppliedCursor = null;
    reconnectAttempts = 0;
  }

  void _revokeInbox() {
    _stopInbox();
    streamRevoked = true;
    if (!mounted) return;
    setState(() {
      conversations = [];
      availableTags = []; selectedTagId = null; tagsGeneration++;
      channelOptionsGeneration++; channelOptions = []; selectedChannelId = null;
      channelOptionsNext = null; channelOptionsOpen = false;
      channelOptionsLoading = false; channelOptionsError = false;
      unreadOnly = false; assignmentFilter = 'all'; statusFilter = 'all'; channelModeFilter = 'all'; controlModeFilter = 'all'; sortFilter = 'id'; activityWindow = 'all'; activitySince = null;
      tagFilterOpen = false; tagsLoading = false; tagsError = false;
      newInboundAlerts.clear();
      selected = null;
      messages = [];
      conversationNext = null;
      messageNext = null;
      messageGeneration++;
      listGeneration++;
      listError = true;
      loading = false;
      reading = false;
      markingRead = false;
      readReceiptError = false;
    });
  }

  /// Recover only this authenticated actor's checkpoint. If the lookup fails
  /// transiently, replay from zero rather than guessing a position.
  Future<void> _startInbox() async {
    final version = streamGeneration;
    final tenant = widget.tenantId;
    try {
      if (!api.authenticated) await api.refresh();
      final response = await api.request('GET', '/tenants/$tenant/inbox/checkpoint')
          as Map<String, dynamic>;
      final cursor = response['after'];
      if (cursor != null &&
          (cursor is! String || !validInboxCursor(cursor) || cursor == '0')) {
        throw const FormatException('Invalid persisted inbox checkpoint');
      }
      if (!mounted || version != streamGeneration || tenant != widget.tenantId) return;
      eventCursor = cursor as String?;
    } catch (error) {
      if (!mounted || version != streamGeneration || tenant != widget.tenantId) return;
      if (error is ApiFailure && [401, 403, 404].contains(error.status)) {
        _revokeInbox();
        return;
      }
      eventCursor = null; // Never skip events because checkpoint recovery failed.
    }
    if (!mounted || version != streamGeneration || tenant != widget.tenantId) return;
    load();
    _connectInbox();
  }

  String? _maxCursor(String? first, String? second) {
    if (first == null) return second;
    if (second == null) return first;
    return BigInt.parse(first) >= BigInt.parse(second) ? first : second;
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
              BigInt.parse(event.sequence) <= BigInt.parse(eventCursor!))) {
        return;
      }
      eventCursor = event.sequence;
      pendingAppliedCursor = _maxCursor(pendingAppliedCursor, event.sequence);
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
        !widget.realtimeEnabled || reconnectTimer != null) {
      return;
    }
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
    // Never allow overlapping REST snapshots for this tenant to discard an
    // earlier affected conversation. A tenant switch resets this generation.
    if (activeRefreshStream == streamGeneration) return;
    final activeStream = streamGeneration;
    activeRefreshStream = activeStream;
    final affected = Set<String>.of(changedConversations);
    final appliedThrough = pendingAppliedCursor;
    changedConversations.clear();
    pendingAppliedCursor = null;
    final refreshVersion = ++refreshGeneration;
    final streamVersion = streamGeneration;
    final listVersion = listGeneration;
    final selectedId = selected?['id'] as String?;
    final messageVersion = messageGeneration;
    final tenant = widget.tenantId;
    final searchAtStart = searchQuery;
    final tagAtStart = selectedTagId;
    final unreadAtStart = unreadOnly;
    final assignmentAtStart = assignmentFilter;
    final statusAtStart = statusFilter;
    final channelModeAtStart = channelModeFilter;
    final controlModeAtStart = controlModeFilter;
    final sortAtStart = sortFilter;
    final activityAtStart = activitySince;
    final channelAtStart = selectedChannelId;
    final listPages = ((conversations.length + 49) ~/ 50).clamp(1, 10);
    final messagePages = ((messages.length ~/ 50) + 1).clamp(1, 10);
    try {
      final updated = <Map<String, dynamic>>[];
      String? after;
      for (var i = 0; i < listPages; i++) {
        final params = <String, String>{
          if (searchAtStart.isNotEmpty) 'q': searchAtStart,
          if (tagAtStart != null) 'tagId': tagAtStart,
          if (unreadAtStart) 'unreadOnly': 'true',
          if (assignmentAtStart != 'all') 'assignment': assignmentAtStart,
          if (statusAtStart != 'all') 'status': statusAtStart,
          if (channelModeAtStart != 'all') 'channelMode': channelModeAtStart,
          if (controlModeAtStart != 'all') 'controlMode': controlModeAtStart,
          if (sortAtStart != 'id') 'sort': sortAtStart,
          if (activityAtStart != null) 'activitySince': activityAtStart,
          if (channelAtStart != null) 'channelId': channelAtStart,
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
          tagAtStart != selectedTagId || unreadAtStart != unreadOnly ||
          assignmentAtStart != assignmentFilter ||
          statusAtStart != statusFilter ||
          channelModeAtStart != channelModeFilter ||
          controlModeAtStart != controlModeFilter ||
          sortAtStart != sortFilter ||
          activityAtStart != activitySince ||
          channelAtStart != selectedChannelId ||
          tenant != widget.tenantId) {
        return;
      }
      refreshAttempts = 0;
      refreshRetryTimer?.cancel();
      refreshRetryTimer = null;
      setState(() {
        // Notify only after a verified REST increase, never from an SSE ID
        // alone or on the initial load. A read acknowledgement clears it.
        final prior = {for (final row in conversations) row['id']: row};
        for (final row in updated) {
          final id = row['id'] as String;
          final before = prior[id]?['unreadCount'];
          final after = row['unreadCount'];
          if (affected.contains(id) && before is int && after is int && after > before) {
            newInboundAlerts.add(id);
          }
          if (after is int && after == 0) newInboundAlerts.remove(id);
        }
        newInboundAlerts.removeWhere((id) => !updated.any((row) => row['id'] == id));
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
      unawaited(loadUnreadSummary());
      if (appliedThrough != null) {
        // Persist only after the REST view was applied. Failure to persist
        // causes safe replay after reload; it never confirms messages as read.
        try {
          await api.request('POST', '/tenants/$tenant/inbox/checkpoint',
              {'after': appliedThrough}, false);
        } catch (error) {
          if (mounted && streamVersion == streamGeneration &&
              tenant == widget.tenantId &&
              error is ApiFailure && [401, 403, 404].contains(error.status)) {
            _revokeInbox();
          }
        }
      }
    } catch (error) {
      if (!mounted || streamVersion != streamGeneration || tenant != widget.tenantId) return;
      if (error is ApiFailure && [401, 403, 404].contains(error.status)) {
        _revokeInbox();
      } else if (refreshVersion == refreshGeneration) {
        // Do not advance the displayed view permanently past an unrefreshed event.
        changedConversations.addAll(affected);
        pendingAppliedCursor = _maxCursor(pendingAppliedCursor, appliedThrough);
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
      if (activeRefreshStream == activeStream) {
        activeRefreshStream = null;
        if (mounted && refreshRetryTimer == null &&
            changedConversations.isNotEmpty) {
          _scheduleInboxRefresh();
        }
      }
    }
  }

  Future<void> loadChannelOptions({bool more = false}) async {
    if (channelOptionsLoading) return;
    final generation = ++channelOptionsGeneration;
    final tenant = widget.tenantId;
    final after = more ? channelOptionsNext : null;
    setState(() {
      channelOptionsLoading = true;
      channelOptionsError = false;
    });
    try {
      final params = after == null ? '' : '?after=$after';
      final result = await api.request('GET',
          '/tenants/$tenant/inbox/channel-options$params') as Map<String, dynamic>;
      final items = (result['items'] as List).cast<Map<String, dynamic>>();
      final next = result['next'];
      if (items.length > 50 || (next != null && next is! String) ||
          items.any((item) => item['id'] is! String ||
              item['displayName'] is! String ||
              !['mock', 'live'].contains(item['mode']))) {
        throw const FormatException('Invalid channel catalog');
      }
      if (!mounted || generation != channelOptionsGeneration ||
          tenant != widget.tenantId) {
        return;
      }
      setState(() {
        channelOptions = more ? [...channelOptions, ...items] : items;
        channelOptionsNext = next as String?;
      });
    } catch (error) {
      if (!mounted || generation != channelOptionsGeneration ||
          tenant != widget.tenantId) {
        return;
      }
      if (error is ApiFailure && [401, 403, 404].contains(error.status)) {
        _revokeInbox();
        return;
      }
      setState(() {
        if (!more) {
          channelOptions = [];
          channelOptionsNext = null;
        }
        channelOptionsError = true;
      });
    } finally {
      if (mounted && generation == channelOptionsGeneration &&
          tenant == widget.tenantId) {
        setState(() => channelOptionsLoading = false);
      }
    }
  }

  void chooseChannel(String? id) {
    if (selectedChannelId == id) return;
    setState(() {
      selectedChannelId = id;
      newInboundAlerts.clear();
      changedConversations.clear();
    });
    load();
  }

  Future<void> loadTagCatalog() async {
    final version = ++tagsGeneration;
    final tenant = widget.tenantId;
    setState(() { tagsLoading = true; tagsError = false; });
    try {
      final response = await api.request('GET', '/tenants/$tenant/conversation-tags')
          as Map<String, dynamic>;
      final raw = (response['items'] as List).cast<Map<String, dynamic>>();
      if (raw.length > 100 || raw.any((row) =>
          row['id'] is! String || row['name'] is! String)) {
        throw const FormatException('Invalid tag catalog');
      }
      if (!mounted || version != tagsGeneration || tenant != widget.tenantId) return;
      setState(() => availableTags = raw);
    } catch (_) {
      if (!mounted || version != tagsGeneration || tenant != widget.tenantId) return;
      setState(() { availableTags = []; tagsError = true; });
    } finally {
      if (mounted && version == tagsGeneration && tenant == widget.tenantId) {
        setState(() => tagsLoading = false);
      }
    }
  }

  void chooseTag(String? tagId) {
    if (selectedTagId == tagId) return;
    setState(() {
      selectedTagId = tagId;
      newInboundAlerts.clear();
      changedConversations.clear();
    });
    load(); // Filter change starts at page one, never reuses a stale cursor.
  }

  void chooseUnreadOnly(bool value) {
    if (unreadOnly == value) return;
    setState(() {
      unreadOnly = value;
      newInboundAlerts.clear();
      changedConversations.clear();
    });
    load(); // Filter change resets the cursor and any selection.
  }

  Future<void> loadUnreadSummary() async {
    final generation = ++summaryGeneration;
    final stream = streamGeneration;
    final tenant = widget.tenantId;
    try {
      if (!api.authenticated) await api.refresh();
      final response = await api.request('GET', '/tenants/$tenant/inbox/unread-summary')
          as Map<String, dynamic>;
      final conversations = response['unreadConversations'];
      final messages = response['unreadMessages'];
      if (conversations is! int || messages is! int ||
          conversations < 0 || messages < 0) {
        throw const FormatException('Invalid unread summary');
      }
      if (!mounted || streamRevoked || stream != streamGeneration ||
          generation != summaryGeneration || tenant != widget.tenantId) {
        return;
      }
      setState(() {
        tenantUnreadConversations = conversations;
        tenantUnreadMessages = messages;
      });
    } catch (_) {
      if (!mounted || streamRevoked || stream != streamGeneration ||
          generation != summaryGeneration || tenant != widget.tenantId) {
        return;
      }
      // Never present an old tenant-wide count as a current result.
      setState(() {
        tenantUnreadConversations = null;
        tenantUnreadMessages = null;
      });
    }
  }

  Future<void> load({bool more = false}) async {
    final generation = ++listGeneration;
    final params = <String, String>{if (searchQuery.isNotEmpty) 'q': searchQuery,
      if (selectedTagId != null) 'tagId': selectedTagId!,
      if (unreadOnly) 'unreadOnly': 'true',
      if (assignmentFilter != 'all') 'assignment': assignmentFilter,
      if (statusFilter != 'all') 'status': statusFilter,
      if (channelModeFilter != 'all') 'channelMode': channelModeFilter,
      if (controlModeFilter != 'all') 'controlMode': controlModeFilter,
      if (sortFilter != 'id') 'sort': sortFilter,
      if (activitySince != null) 'activitySince': activitySince!,
      if (selectedChannelId != null) 'channelId': selectedChannelId!,
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
      unawaited(loadUnreadSummary());
    } catch (error) {
      if (!mounted || generation != listGeneration) return;
      // A changed assignment/read state can expire a keyset cursor between
      // pages. Re-fetch the first page for the *same* filters and sort rather
      // than erasing the inbox or retrying a stale cursor indefinitely.
      if (more && error is ApiFailure && error.status == 404) {
        await load();
        return;
      }
      setState(() {
        listError = true;
        // A refresh may reveal revoked access. Do not keep sensitive cached data visible.
        conversations = []; newInboundAlerts.clear(); selected = null; messages = []; conversationNext = null;
        summaryGeneration++; tenantUnreadConversations = null; tenantUnreadMessages = null;
        messageGeneration++; reading = false; messageNext = null;
      });
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

  Future<void> markRead() async {
    final id = selected?['id'] as String?;
    final upTo = selected?['unreadUpTo'] as String?;
    if (id == null || upTo == null || markingRead || reading || messageError) return;
    final generation = messageGeneration;
    final tenant = widget.tenantId;
    setState(() { markingRead = true; readReceiptError = false; });
    try {
      final receipt = await api.request('POST', '$base/$id/read',
          {'upTo': upTo}, false) as Map<String, dynamic>;
      if (!mounted || generation != messageGeneration ||
          tenant != widget.tenantId || selected?['id'] != id) {
        return;
      }
      if (receipt['unreadUpTo'] is! String) {
        throw const FormatException('Invalid read receipt');
      }
      setState(() {
        conversations = conversations.map((row) {
          if (row['id'] != id || row['unreadUpTo'] != upTo) return row;
          newInboundAlerts.remove(id);
          return {...row, 'unreadCount': 0};
        }).toList();
        if (selected?['unreadUpTo'] == upTo) {
          selected = {...selected!, 'unreadCount': 0};
          if (unreadOnly) conversations.removeWhere((row) => row['id'] == id);
        }
      });
      unawaited(loadUnreadSummary());
    } catch (_) {
      if (mounted && generation == messageGeneration && tenant == widget.tenantId) {
        setState(() => readReceiptError = true);
      }
    } finally {
      if (mounted && tenant == widget.tenantId) setState(() => markingRead = false);
    }
  }

  void applyConversationControl(Map<String, dynamic> update) {
    if (!mounted || selected?['id'] != update['id']) return;
    setState(() {
      selected = {...selected!, ...update};
      conversations = conversations.map((row) =>
          row['id'] == update['id'] ? {...row, ...update} : row).toList();
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
    // Only counts the current filtered/paginated REST rows, not the tenant.
    final unreadRows = conversations.where((row) =>
        row['unreadCount'] is int && (row['unreadCount'] as int) > 0).toList();
    final unreadMessages = unreadRows.fold<int>(0,
        (sum, row) => sum + (row['unreadCount'] as int));
    return Column(children: [
      ListTile(title: Text(l.conversations), trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          PopupMenuButton<String>(
            key: const Key('inbox-filter-control-mode'),
            tooltip: controlModeFilter == 'human' ? l.inboxControlHuman :
                controlModeFilter == 'ai' ? l.inboxControlAi :
                controlModeFilter == 'paused' ? l.inboxControlPaused : l.inboxControlAll,
            enabled: !loading,
            initialValue: controlModeFilter,
            icon: Icon(controlModeFilter == 'all' ? Icons.support_agent_outlined : Icons.support_agent),
            itemBuilder: (_) => [
              PopupMenuItem(value: 'all', child: Text(l.inboxControlAll)),
              PopupMenuItem(value: 'human', child: Text(l.inboxControlHuman)),
              PopupMenuItem(value: 'ai', child: Text(l.inboxControlAi)),
              PopupMenuItem(value: 'paused', child: Text(l.inboxControlPaused)),
            ],
            onSelected: (value) {
              if (value == controlModeFilter) return;
              setState(() {
                controlModeFilter = value;
                newInboundAlerts.clear();
                changedConversations.clear();
              });
              load();
            },
          ),
          PopupMenuButton<String>(
            key: const Key('inbox-sort'),
            tooltip: sortFilter == 'recent' ? l.inboxSortRecent : l.inboxSortId,
            enabled: !loading,
            initialValue: sortFilter,
            icon: Icon(sortFilter == 'recent' ? Icons.schedule : Icons.sort_by_alpha),
            itemBuilder: (_) => [
              PopupMenuItem(value: 'id', child: Text(l.inboxSortId)),
              PopupMenuItem(value: 'recent', child: Text(l.inboxSortRecent)),
            ],
            onSelected: (value) {
              if (value == sortFilter) return;
              setState(() {
                sortFilter = value;
                newInboundAlerts.clear();
                changedConversations.clear();
              });
              load();
            },
          ),
          IconButton(tooltip: l.retry, onPressed: loading ? null : () => load(),
              icon: const Icon(Icons.refresh)),
        ],
      )),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: TextField(
        controller: search, maxLength: 80, textInputAction: TextInputAction.search,
        decoration: InputDecoration(labelText: l.conversationSearch, suffixIcon: IconButton(
          tooltip: l.conversationClear, icon: const Icon(Icons.clear), onPressed: () { search.clear(); searchQuery = ''; load(); })),
        onSubmitted: (_) { searchQuery = search.text.trim(); load(); },
      )),
      TextButton.icon(onPressed: () { searchQuery = search.text.trim(); load(); }, icon: const Icon(Icons.search), label: Text(l.conversationSearchAction)),
      Wrap(spacing: 4, children: [
        TextButton.icon(
          key: const Key('inbox-filter-tags'),
          onPressed: () {
            setState(() => tagFilterOpen = !tagFilterOpen);
            if (tagFilterOpen && availableTags.isEmpty) loadTagCatalog();
          },
          icon: const Icon(Icons.filter_alt_outlined),
          label: Text(l.inboxTagFilter),
        ),
        if (selectedTagId != null)
          TextButton(onPressed: () => chooseTag(null), child: Text(l.inboxAllTags)),
        IconButton(
          key: const Key('inbox-filter-channels'),
          tooltip: l.inboxChannelFilter,
          onPressed: () {
            setState(() => channelOptionsOpen = !channelOptionsOpen);
            if (channelOptionsOpen && channelOptions.isEmpty) loadChannelOptions();
          },
          icon: Icon(selectedChannelId == null ? Icons.hub_outlined : Icons.hub),
        ),
        SizedBox(width: 264, child: DropdownButton<String>(
          key: const Key('inbox-filter-assignment'),
          isExpanded: true,
          value: assignmentFilter,
          items: [
            DropdownMenuItem(value: 'all', child: Text(l.inboxAssignmentAll)),
            DropdownMenuItem(value: 'mine', child: Text(l.inboxAssignmentMine)),
            DropdownMenuItem(value: 'unassigned', child: Text(l.inboxAssignmentUnassigned)),
          ],
          onChanged: loading ? null : (value) {
            if (value == null || value == assignmentFilter) return;
            setState(() => assignmentFilter = value);
            load();
          },
        )),
        PopupMenuButton<String>(
          key: const Key('inbox-filter-status'),
          tooltip: statusFilter == 'open' ? l.inboxStatusOpen :
              statusFilter == 'closed' ? l.inboxStatusClosed : l.inboxStatusAll,
          enabled: !loading,
          initialValue: statusFilter,
          icon: Icon(statusFilter == 'all'
              ? Icons.filter_list_outlined : Icons.filter_alt),
          itemBuilder: (_) => [
            PopupMenuItem(value: 'all', child: Text(l.inboxStatusAll)),
            PopupMenuItem(value: 'open', child: Text(l.inboxStatusOpen)),
            PopupMenuItem(value: 'closed', child: Text(l.inboxStatusClosed)),
          ],
          onSelected: (value) {
            if (value == statusFilter) return;
            setState(() => statusFilter = value);
            load();
          },
        ),
        PopupMenuButton<String>(
          key: const Key('inbox-filter-channel-mode'),
          tooltip: channelModeFilter == 'mock' ? l.inboxChannelModeMock :
              channelModeFilter == 'live' ? l.inboxChannelModeLive : l.inboxChannelModeAll,
          enabled: !loading,
          initialValue: channelModeFilter,
          icon: Icon(channelModeFilter == 'all'
              ? Icons.layers_outlined : Icons.layers),
          itemBuilder: (_) => [
            PopupMenuItem(value: 'all', child: Text(l.inboxChannelModeAll)),
            PopupMenuItem(value: 'mock', child: Text(l.inboxChannelModeMock)),
            PopupMenuItem(value: 'live', child: Text(l.inboxChannelModeLive)),
          ],
          onSelected: (value) {
            if (value == channelModeFilter) return;
            setState(() {
              channelModeFilter = value;
              newInboundAlerts.clear();
              changedConversations.clear();
            });
            load();
          },
        ),
        PopupMenuButton<String>(
          key: const Key('inbox-filter-activity'),
          tooltip: activityWindow == 'day' ? l.inboxActivityDay :
              activityWindow == 'week' ? l.inboxActivityWeek :
              activityWindow == 'month' ? l.inboxActivityMonth : l.inboxActivityAll,
          enabled: !loading,
          initialValue: activityWindow,
          icon: Icon(activityWindow == 'all' ? Icons.history_toggle_off : Icons.history),
          itemBuilder: (_) => [
            PopupMenuItem(value: 'all', child: Text(l.inboxActivityAll)),
            PopupMenuItem(value: 'day', child: Text(l.inboxActivityDay)),
            PopupMenuItem(value: 'week', child: Text(l.inboxActivityWeek)),
            PopupMenuItem(value: 'month', child: Text(l.inboxActivityMonth)),
          ],
          onSelected: (value) {
            if (value == activityWindow) return;
            // Capture the time once, never recompute during pagination or
            // SSE reconciliation. This is an inclusive UTC threshold.
            final days = value == 'day' ? 1 : value == 'week' ? 7 : 30;
            final cutoff = DateTime.now().toUtc().subtract(Duration(days: days));
            setState(() {
              activityWindow = value;
              activitySince = value == 'all' ? null :
                  DateTime.fromMillisecondsSinceEpoch(cutoff.millisecondsSinceEpoch,
                      isUtc: true).toIso8601String();
              newInboundAlerts.clear();
              changedConversations.clear();
            });
            load();
          },
        ),
        FilterChip(
          key: const Key('inbox-filter-unread'),
          label: Text(l.inboxUnreadOnly),
          selected: unreadOnly,
          onSelected: loading ? null : chooseUnreadOnly,
        ),
      ]),
      if (channelOptionsOpen) SizedBox(height: 134, child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Column(children: [
          if (channelOptionsLoading) const LinearProgressIndicator(),
          if (channelOptionsError) TextButton(
            onPressed: channelOptionsLoading ? null :
                () => loadChannelOptions(more: channelOptions.isNotEmpty),
            child: Text(l.retry),
          ),
          Wrap(spacing: 6, runSpacing: 4, children: [
            ChoiceChip(
              key: const Key('inbox-channel-all'),
              label: Text(l.inboxAllChannels),
              selected: selectedChannelId == null,
              onSelected: (_) => chooseChannel(null),
            ),
            for (final option in channelOptions)
              ChoiceChip(
                key: ValueKey('inbox-channel-${option['id']}'),
                label: Text(option['displayName'] as String),
                selected: selectedChannelId == option['id'],
                onSelected: (_) => chooseChannel(option['id'] as String),
              ),
          ]),
          if (channelOptionsNext != null && !channelOptionsError)
            TextButton(
              key: const Key('inbox-channel-more'),
              onPressed: channelOptionsLoading ? null :
                  () => loadChannelOptions(more: true),
              child: Text(l.inboxMoreChannels),
            ),
        ]),
      )),
      if (tagFilterOpen) SizedBox(height: 92, child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Column(children: [
          if (tagsLoading) const LinearProgressIndicator(),
          if (tagsError) TextButton(onPressed: loadTagCatalog, child: Text(l.retry)),
          if (!tagsLoading && !tagsError) Wrap(spacing: 8, children: [
            ChoiceChip(
              key: const Key('inbox-filter-all'),
              label: Text(l.inboxAllTags),
              selected: selectedTagId == null,
              onSelected: (_) => chooseTag(null),
            ),
            for (final tag in availableTags)
              ChoiceChip(
                key: ValueKey('inbox-filter-${tag['id']}'),
                label: Text(tag['name'] as String),
                selected: selectedTagId == tag['id'],
                onSelected: (_) => chooseTag(tag['id'] as String),
              ),
          ]),
        ]),
      )),
      if (loading) const LinearProgressIndicator(),
      if (!loading && !listError && tenantUnreadConversations != null &&
          tenantUnreadMessages != null) Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        child: Text(
          l.inboxUnreadTenantSummary(tenantUnreadConversations!, tenantUnreadMessages!),
          key: const Key('inbox-unread-tenant-summary'),
          style: Theme.of(context).textTheme.labelSmall,
        ),
      ),
      if (!loading && !listError) Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        child: Text(
          l.inboxUnreadLoadedSummary(unreadRows.length, unreadMessages),
          key: const Key('inbox-unread-loaded-summary'),
          style: Theme.of(context).textTheme.labelSmall,
        ),
      ),
      if (listError) errorPanel(() => load()),
      if (!loading && !listError && conversations.isEmpty) Padding(padding: const EdgeInsets.all(24), child: Text(searchQuery.isEmpty ? l.noConversations : l.conversationNoMatches)),
      if (newInboundAlerts.isNotEmpty) ListTile(
        leading: const Icon(Icons.notifications_active_outlined),
        title: Text(l.inboxNewMessageAlert),
        trailing: Badge(label: Text('${newInboundAlerts.length}'),
          child: const Icon(Icons.mark_chat_unread_outlined)),
      ),
      Expanded(child: ListView(children: [
        for (final c in conversations) ListTile(
          selected: selected?['id'] == c['id'],
          leading: const Icon(Icons.chat_bubble_outline),
          trailing: c['unreadCount'] is int && (c['unreadCount'] as int) > 0
              ? Badge(
                  label: Text('${c['unreadCount']}'),
                  child: const Icon(Icons.mark_chat_unread_outlined),
                )
              : null,
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
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          IconButton(
            tooltip: l.inboxTags,
            icon: const Icon(Icons.label_outline),
            onPressed: () => showModalBottomSheet<void>(
              context: context,
              isScrollControlled: true,
              builder: (_) => SafeArea(child: Padding(
                padding: const EdgeInsets.all(16),
                child: SingleChildScrollView(child: ConversationTags(
                  tenantId: widget.tenantId,
                  conversationId: selected!['id'] as String,
                  api: api,
                )),
              )),
            ),
          ),
          IconButton(tooltip: l.retry, onPressed: reading ? null : () => open(selected!), icon: const Icon(Icons.refresh)),
        ]),
      ),
      if (!reading && !messageError &&
          selected!['unreadCount'] is int &&
          (selected!['unreadCount'] as int) > 0 &&
          selected!['unreadUpTo'] is String)
        TextButton.icon(
          onPressed: markingRead ? null : markRead,
          icon: const Icon(Icons.done_all),
          label: Text(l.inboxMarkRead),
        ),
      if (markingRead) const LinearProgressIndicator(),
      if (readReceiptError)
        TextButton(onPressed: markingRead ? null : markRead, child: Text(l.retry)),
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
      ConversationCustomerContext(
        tenantId: widget.tenantId,
        conversationId: selected!['id'] as String,
        api: api,
      ),
      ConversationInternalNotes(
        key: ValueKey('notes/${widget.tenantId}/${selected!['id']}'),
        tenantId: widget.tenantId,
        conversationId: selected!['id'] as String,
        api: api,
      ),
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
    return Scaffold(appBar: AppBar(title: Text(l.conversations), leading: IconButton(tooltip: l.account, icon: const Icon(Icons.arrow_back), onPressed: () => context.go('/account')),
      actions: [if (newInboundAlerts.isNotEmpty) Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Tooltip(message: l.inboxNewMessageAlert,
          child: Badge(label: Text('${newInboundAlerts.length}'),
            child: const Icon(Icons.notifications_active_outlined))),
      )]),
      body: LayoutBuilder(builder: (context, constraints) {
        if (constraints.maxWidth < 760) return selected == null ? conversationList() : history(narrow: true);
        return Row(children: [SizedBox(width: 320, child: conversationList()), const VerticalDivider(width: 1), Expanded(child: history(narrow: false))]);
      }),
    );
  }
}
