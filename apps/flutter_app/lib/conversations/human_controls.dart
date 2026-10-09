import 'package:flutter/material.dart';
import '../channels/simulation_page.dart' show simulationId;
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';

/// Tenant-scoped human control for one selected conversation.
/// Never infers delivery from a durable reply receipt.
class ConversationHumanControls extends StatefulWidget {
  const ConversationHumanControls({
    super.key,
    required this.tenantId,
    required this.conversation,
    required this.api,
    required this.onChanged,
    required this.onRevoked,
  });

  final String tenantId;
  final Map<String, dynamic> conversation;
  final IdentityApi api;
  final ValueChanged<Map<String, dynamic>> onChanged;
  final VoidCallback onRevoked;

  @override
  State<ConversationHumanControls> createState() => _ConversationHumanControlsState();
}

class _ConversationHumanControlsState extends State<ConversationHumanControls> {
  final reply = TextEditingController();
  List<Map<String, dynamic>> staff = [];
  String? selectedStaffId;
  Map<String, String>? pending;
  String? replyState;
  bool busy = false;
  bool staffBusy = false;
  bool staffFailed = false;
  bool retryableError = false;
  bool blocked = false;
  bool actionFailed = false;
  int generation = 0;
  int receiptGeneration = 0;
  bool reconciling = false;
  bool reconcileFailed = false;
  bool recovered = false;

  String get conversationId => widget.conversation['id'] as String;
  String get mode => widget.conversation['mode'] as String? ?? '';
  bool get canTakeover => mode == 'AI_ACTIVE' || mode == 'WAITING_HUMAN';
  bool replyAvailable(Map<String, dynamic> conversation) =>
      conversation['mode'] == 'HUMAN_ACTIVE' &&
      conversation['assignedStaffId'] is String &&
      (conversation['channelConnection'] as Map?)?['mode'] == 'live';
  bool get canReply => replyAvailable(widget.conversation);
  bool get closed => mode == 'CLOSED' ||
      widget.conversation['status'] == 'closed' ||
      widget.conversation['status'] == 'archived';
  String get path => '/tenants/${widget.tenantId}/conversations/$conversationId';

  @override
  void initState() {
    super.initState();
    if (canTakeover) fetchStaff();
    if (canReply) recoverLatest();
  }

  @override
  void didUpdateWidget(covariant ConversationHumanControls oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tenantId != widget.tenantId ||
        oldWidget.conversation['id'] != widget.conversation['id']) {
      generation++;
      receiptGeneration++;
      staff = [];
      selectedStaffId = null;
      pending = null;
      replyState = null;
      reply.clear();
      busy = false;
      blocked = false;
      retryableError = false;
      actionFailed = false;
      staffBusy = false;
      reconciling = false;
      reconcileFailed = false;
      recovered = false;
      if (canTakeover) fetchStaff();
      if (canReply) recoverLatest();
    } else if (!canReply && mode != 'HUMAN_ACTIVE') {
      pending = null;
      replyState = null;
      blocked = false;
      retryableError = false;
      recovered = false;
      reconcileFailed = false;
      receiptGeneration++;
    } else if (canReply && !replyAvailable(oldWidget.conversation)) {
      recoverLatest();
    }
  }

  @override
  void dispose() {
    generation++;
    receiptGeneration++;
    reply.dispose();
    super.dispose();
  }

  void revoked(Object error) {
    if (error is ApiFailure && [401, 403, 404].contains(error.status)) {
      widget.onRevoked();
    }
  }

  Future<void> fetchStaff() async {
    final version = ++generation;
    setState(() { staffBusy = true; staffFailed = false; });
    try {
      if (!widget.api.authenticated) await widget.api.refresh();
      final data = (await widget.api.request('GET', '/tenants/${widget.tenantId}/staff') as List)
          .cast<Map<String, dynamic>>();
      if (!mounted || version != generation) return;
      setState(() {
        staff = data.where((item) => item['active'] == true && item['id'] is String).toList();
        selectedStaffId = staff.any((item) => item['id'] == selectedStaffId)
            ? selectedStaffId : null;
      });
    } catch (error) {
      if (!mounted || version != generation) return;
      setState(() { staff = []; selectedStaffId = null; staffFailed = true; });
      revoked(error);
    } finally {
      if (mounted && version == generation) setState(() => staffBusy = false);
    }
  }

  Future<void> command(String action, [Map<String, Object?>? body]) async {
    if (busy) return;
    final version = ++generation;
    setState(() { busy = true; actionFailed = false; });
    try {
      final result = await widget.api.request('POST', '$path/$action', body, false)
          as Map<String, dynamic>;
      if (!mounted || version != generation) return;
      if (result['id'] != conversationId ||
          result['mode'] is! String || result['status'] is! String) {
        throw const FormatException('Invalid control receipt');
      }
      widget.onChanged({...widget.conversation, ...result});
      if (!mounted || version != generation) return;
      setState(() {
        if (action == 'reactivate-ai' || action == 'close') {
          pending = null;
          replyState = null;
          reply.clear();
          blocked = false;
          retryableError = false;
        }
      });
    } catch (error) {
      if (!mounted || version != generation) return;
      setState(() => actionFailed = true);
      revoked(error);
    } finally {
      if (mounted && version == generation) setState(() => busy = false);
    }
  }


  /// Reconcile only committed intents belonging to the signed-in operator.
  /// An absent row is not proof that a network-uncertain POST cannot still commit.
  Future<void> recoverLatest() async {
    if (!canReply || reconciling) return;
    final version = ++receiptGeneration;
    setState(() { reconciling = true; reconcileFailed = false; });
    try {
      if (!widget.api.authenticated) await widget.api.refresh();
      final response = await widget.api.request(
        'GET', '$path/manual-replies/latest',
      ) as Map<String, dynamic>;
      if (!mounted || version != receiptGeneration || !canReply) return;
      final item = response['item'];
      if (item != null &&
          (item is! Map<String, dynamic> ||
              item['intentId'] is! String ||
              item['requestId'] is! String ||
              item['text'] is! String ||
              !{'pending', 'accepted', 'rejected', 'failed'}.contains(item['state']))) {
        throw const FormatException('Invalid manual reply recovery');
      }
      if (item != null &&
          pending != null &&
          (item['requestId'] != pending!['requestId'] ||
              item['text'] != pending!['text'])) {
        // Never replace an unresolved in-memory attempt with an older receipt.
        return;
      }
      setState(() {
        if (item != null) {
          pending = {
            'requestId': item['requestId'] as String,
            'text': item['text'] as String,
          };
          replyState = item['state'] as String;
          reply.text = item['text'] as String;
          retryableError = false;
          recovered = true;
        }
      });
    } catch (error) {
      if (!mounted || version != receiptGeneration) return;
      setState(() => reconcileFailed = true);
      revoked(error);
    } finally {
      if (mounted && version == receiptGeneration) {
        setState(() => reconciling = false);
      }
    }
  }

  Future<void> send() async {
    if (busy || reconciling || (reconcileFailed && pending == null) ||
        blocked || !canReply) {
      return;
    }
    if (pending == null) {
      if (reply.text.trim().isEmpty || reply.text.runes.length > 4096) return;
      pending = {'requestId': simulationId(), 'text': reply.text};
    }
    final original = pending!;
    final version = ++generation;
    setState(() { busy = true; retryableError = false; actionFailed = false; });
    try {
      final result = await widget.api.request('POST', '$path/messages', original, false)
          as Map<String, dynamic>;
      if (!mounted || version != generation) return;
      if (result['intentId'] is! String ||
          !{'pending', 'accepted', 'rejected', 'failed'}.contains(result['state'])) {
        throw const FormatException('Invalid reply receipt');
      }
      setState(() {
        replyState = result['state'] as String;
        recovered = false;
        // Keep the exact key/payload until the operator explicitly starts another reply.
        retryableError = false;
      });
    } catch (error) {
      if (!mounted || version != generation) return;
      setState(() {
        retryableError = true;
        if (error is ApiFailure && [400, 401, 403, 404, 409].contains(error.status)) {
          blocked = true;
        }
      });
      revoked(error);
      if (error is! ApiFailure ||
          ![400, 401, 403, 404, 409].contains(error.status)) {
        // Read-only check; never automatically submit a second POST.
        await recoverLatest();
      }
    } finally {
      if (mounted && version == generation) setState(() => busy = false);
    }
  }

  void newReply() {
    setState(() {
      pending = null;
      replyState = null;
      retryableError = false;
      blocked = false;
      recovered = false;
      reply.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Wrap(spacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Chip(label: Text(switch (mode) {
            'AI_ACTIVE' => l.inboxAi,
            'HUMAN_ACTIVE' => l.inboxHuman,
            'WAITING_HUMAN' => l.inboxWaiting,
            'CLOSED' => l.inboxClosed,
            _ => mode,
          })),
          if (!closed) TextButton.icon(
            onPressed: busy ? null : () => command('close'),
            icon: const Icon(Icons.check_circle_outline),
            label: Text(l.inboxResolve),
          ),
          if (mode == 'HUMAN_ACTIVE') OutlinedButton(
            onPressed: busy ? null : () => command('reactivate-ai'),
            child: Text(l.inboxReactivate),
          ),
        ]),
        if (canTakeover) ...[
          if (staffBusy) const LinearProgressIndicator(),
          if (staffFailed) TextButton(onPressed: staffBusy ? null : fetchStaff, child: Text(l.retry)),
          if (!staffBusy && staff.isNotEmpty) Row(children: [
            Expanded(child: DropdownButtonFormField<String>(
              key: const Key('inbox-staff'),
              initialValue: selectedStaffId,
              decoration: InputDecoration(labelText: l.inboxAssign),
              items: staff.map((item) => DropdownMenuItem(
                value: item['id'] as String,
                child: Text(item['name'] as String? ?? ''),
              )).toList(),
              onChanged: busy ? null : (id) => setState(() => selectedStaffId = id),
            )),
            const SizedBox(width: 8),
            FilledButton(
              onPressed: busy || selectedStaffId == null
                  ? null : () => command('takeover', {'staffId': selectedStaffId}),
              child: Text(l.inboxTakeover),
            ),
          ]),
        ],
        if (canReply) ...[
          Text(l.inboxManualHint),
          if (reconciling) ...[
            const LinearProgressIndicator(),
            Text(l.inboxReconciling),
          ],
          if (reconcileFailed) ...[
            Text(l.inboxReconcileFailed),
            TextButton(
              onPressed: busy || reconciling ? null : recoverLatest,
              child: Text(l.inboxCheckPrevious),
            ),
          ],
          if (recovered) Text(l.inboxRecovered),
          if (recovered && pending != null)
            SelectableText(pending!['text']!),

          const SizedBox(height: 8),
          if (pending == null) TextField(
            key: const Key('inbox-compose'),
            controller: reply,
            enabled: !busy && !reconciling && !reconcileFailed,
            minLines: 2,
            maxLines: 5,
            maxLength: 4096,
            decoration: InputDecoration(labelText: l.inboxReply),
          ),
          if (replyState == null) FilledButton.icon(
            onPressed: busy || reconciling ||
                (reconcileFailed && pending == null) || blocked ? null : send,
            icon: const Icon(Icons.send_outlined),
            label: Text(pending == null ? l.inboxReply : l.inboxRetrySame),
          ),
          if (replyState != null) ...[
            Semantics(liveRegion: true, child: Text(
              replyState == 'pending' ? l.inboxQueued :
              replyState == 'accepted' ? l.inboxAccepted : l.inboxNotSent,
            )),
            TextButton(onPressed: busy || reconciling || reconcileFailed ? null : newReply,
                child: Text(l.inboxNewReply)),
          ],
          if (retryableError) Text(blocked ? l.inboxBlocked : l.inboxUncertain),
        ],
        if (actionFailed) Text(l.actionError),
      ]),
    );
  }
}
