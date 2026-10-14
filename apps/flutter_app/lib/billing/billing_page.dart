import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';

// This page is strictly read-only: neither the UI nor a billing status
// string can authorize paid activity before server-side quotas/entitlements.
class BillingPage extends StatefulWidget {
  const BillingPage({super.key, required this.tenantId, this.api});
  final String tenantId;
  final IdentityApi? api;

  @override
  State<BillingPage> createState() => _BillingPageState();
}

class _BillingPageState extends State<BillingPage> {
  late final IdentityApi api;
  bool busy = true;
  bool ready = false;
  bool forbidden = false;
  int generation = 0;
  List<Map<String, dynamic>> plans = [];
  Map<String, dynamic>? subscription;

  @override
  void initState() {
    super.initState();
    api = widget.api ?? IdentityApi();
    load();
  }

  @override
  void didUpdateWidget(covariant BillingPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tenantId != widget.tenantId) load();
  }

  @override
  void dispose() {
    generation++;
    if (widget.api == null) api.dispose();
    super.dispose();
  }

  Future<void> load() async {
    final current = ++generation;
    final tenant = widget.tenantId;
    setState(() {
      busy = true;
      ready = false;
      forbidden = false;
      plans = [];
      subscription = null;
    });
    try {
      if (!api.authenticated) await api.refresh();
      final path = '/tenants/$tenant/billing';
      final catalog = await api.request('GET', '$path/plans');
      final details = await api.request('GET', '$path/subscription');
      if (catalog is! Map<String, dynamic> ||
          catalog['items'] is! List ||
          details is! Map<String, dynamic> ||
          details['entitlements'] is! Map<String, dynamic>) {
        throw const FormatException('Unexpected billing response');
      }
      final entitlement = details['entitlements'] as Map<String, dynamic>;
      // Fail closed if a future backend reports a billing-enabled state
      // before this read-only view supports its contractual semantics.
      if (entitlement['automationEnabled'] != false ||
          entitlement['billingVerified'] != false) {
        throw const FormatException('Unrecognised billing permissions');
      }
      final rawPlans = catalog['items'] as List;
      if (rawPlans.any((item) => item is! Map<String, dynamic>) ||
          (details['subscription'] != null &&
              details['subscription'] is! Map<String, dynamic>)) {
        throw const FormatException('Invalid billing items');
      }
      if (!mounted || current != generation || tenant != widget.tenantId) return;
      setState(() {
        plans = rawPlans.cast<Map<String, dynamic>>();
        subscription = details['subscription'] as Map<String, dynamic>?;
        ready = true;
        busy = false;
      });
    } catch (error) {
      if (!mounted || current != generation || tenant != widget.tenantId) return;
      setState(() {
        forbidden = error is ApiFailure && [401, 403, 404].contains(error.status);
        ready = false;
        busy = false;
        plans = [];
        subscription = null;
      });
    }
  }

  String periodLabel(String raw, AppLocalizations l) {
    return switch (raw) {
      'month' => l.billingIntervalMonth,
      'year' => l.billingIntervalYear,
      _ => raw,
    };
  }

  String formattedDate(Object? value, BuildContext context) {
    final parsed = value is String ? DateTime.tryParse(value) : null;
    if (parsed == null) return '—';
    return MaterialLocalizations.of(context).formatMediumDate(parsed.toLocal());
  }

  Widget planCard(Map<String, dynamic> plan, AppLocalizations l) {
    final name = plan['name'];
    final currency = plan['currency'];
    final price = plan['basePrice'];
    final interval = plan['billingInterval'];
    final title = name is String ? name : '—';
    final priceLine = currency is String && price is String && interval is String
        ? '$currency $price / ${periodLabel(interval, l)}'
        : '—';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 6),
          Text(priceLine),
          const SizedBox(height: 8),
          Text('${l.billingIncludedConversations}: ${plan['includedConversations'] ?? '—'}'),
          Text('${l.billingIncludedStaff}: ${plan['includedStaff'] ?? '—'}'),
          Text('${l.billingIncludedChannels}: ${plan['includedChannels'] ?? '—'}'),
          Text('${l.billingIncludedLocations}: ${plan['includedLocations'] ?? '—'}'),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final row = subscription;
    return Scaffold(
      appBar: AppBar(
        title: Text(l.billingTitle),
        leading: IconButton(
          tooltip: l.account,
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/account'),
        ),
        actions: [
          IconButton(
            key: const Key('billing-refresh'),
            tooltip: l.billingRefresh,
            onPressed: busy ? null : load,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 900),
          child: ListView(padding: const EdgeInsets.all(20), children: [
            Text(l.billingHint),
            const SizedBox(height: 16),
            if (busy) const LinearProgressIndicator(),
            if (!busy && !ready)
              Semantics(liveRegion: true, child: Text(
                forbidden ? l.billingForbidden : l.billingUnavailable,
                key: const Key('billing-error'),
              )),
            if (ready) ...[
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(l.billingSubscriptionTitle,
                        style: Theme.of(context).textTheme.titleLarge),
                    const SizedBox(height: 8),
                    if (row == null)
                      Text(l.billingNoSubscription)
                    else ...[
                      Text('${l.billingStatus}: ${row['status'] ?? '—'}'),
                      if (row['plan'] is Map<String, dynamic>)
                        Text((row['plan'] as Map<String, dynamic>)['name']?.toString() ?? '—'),
                      Text('${l.billingPeriod}: ${formattedDate(row['currentPeriodStart'], context)} – ${formattedDate(row['currentPeriodEnd'], context)}'),
                      if (row['trialEnd'] != null)
                        Text('${l.billingTrialEnd}: ${formattedDate(row['trialEnd'], context)}'),
                      if (row['cancelAtPeriodEnd'] == true)
                        Text(l.billingCancelAtEnd),
                    ],
                    const SizedBox(height: 12),
                    Text(l.billingNotEnabled,
                      key: const Key('billing-inactive-notice'),
                      style: TextStyle(color: Theme.of(context).colorScheme.error)),
                  ]),
                ),
              ),
              const SizedBox(height: 16),
              Text(l.billingPlansTitle, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 8),
              if (plans.isEmpty) Text(l.billingNoPlans),
              for (final plan in plans) planCard(plan, l),
            ],
          ]),
        ),
      ),
    );
  }
}
