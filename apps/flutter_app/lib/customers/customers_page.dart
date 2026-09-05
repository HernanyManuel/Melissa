import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';

class CustomersPage extends StatefulWidget {
  const CustomersPage({super.key, required this.tenantId, this.api});
  final String tenantId;
  final IdentityApi? api;
  @override
  State<CustomersPage> createState() => _CustomersPageState();
}

class _CustomersPageState extends State<CustomersPage> {
  late final IdentityApi api;
  bool busy = true;
  bool canWrite = false;
  bool failed = false;
  List<Map<String, dynamic>> items = [];
  String? next;
  String get path => '/tenants/${widget.tenantId}/customers';
  @override
  void initState() { super.initState(); api = widget.api ?? IdentityApi(); load(); }
  @override
  void dispose() { if (widget.api == null) api.dispose(); super.dispose(); }

  Future<void> load({bool more = false}) async {
    setState(() { busy = true; failed = false; });
    try {
      if (!api.authenticated) await api.refresh();
      final memberships = await api.request('GET', '/tenants') as List;
      final own = memberships.cast<Map<String, dynamic>>().where((m) => m['tenant']['id'] == widget.tenantId);
      canWrite = own.isNotEmpty && ['owner', 'admin', 'manager'].contains(own.first['role']);
      final page = await api.request('GET', '$path${more && next != null ? '?after=$next' : ''}') as Map<String, dynamic>;
      final rows = (page['items'] as List).cast<Map<String, dynamic>>();
      if (!mounted) return;
      setState(() { items = more ? [...items, ...rows] : rows; next = page['next'] as String?; });
    } catch (_) { if (mounted) setState(() => failed = true); }
    if (mounted) setState(() => busy = false);
  }

  Future<void> edit([Map<String, dynamic>? customer]) async {
    final saved = await showDialog<bool>(context: context, barrierDismissible: false,
      builder: (_) => CustomerEditor(api: api, path: path, customer: customer));
    if (saved == true && mounted) await load();
  }

  Future<void> archive(Map<String, dynamic> customer) async {
    final l = AppLocalizations.of(context)!;
    final confirm = await showDialog<bool>(context: context, builder: (context) => AlertDialog(
      title: Text(l.archiveCustomer), content: Text(l.archiveCustomerHint), actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: Text(l.close)),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(l.archiveCustomer)),
      ],
    ));
    if (confirm != true || !mounted) return;
    setState(() { busy = true; failed = false; });
    try { await api.request('DELETE', '$path/${customer['id']}'); if (mounted) await load(); }
    catch (_) { if (mounted) setState(() { busy = false; failed = true; }); }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(title: Text(l.customers), leading: IconButton(tooltip: l.account, icon: const Icon(Icons.arrow_back), onPressed: () => context.go('/account'))),
      body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 900), child: ListView(padding: const EdgeInsets.all(24), children: [
        Row(children: [Expanded(child: Text(l.customers, style: Theme.of(context).textTheme.headlineMedium)),
          IconButton(tooltip: l.retry, onPressed: busy ? null : () => load(), icon: const Icon(Icons.refresh)),
          if (canWrite) FilledButton.icon(onPressed: busy ? null : () => edit(), icon: const Icon(Icons.person_add_outlined), label: Text(l.addCustomer)),
        ]),
        const SizedBox(height: 20),
        if (busy) const LinearProgressIndicator(),
        if (failed) Padding(padding: const EdgeInsets.symmetric(vertical: 16), child: Text(l.actionError, style: TextStyle(color: Theme.of(context).colorScheme.error))),
        if (!busy && !failed && items.isEmpty) Padding(padding: const EdgeInsets.all(32), child: Column(children: [const Icon(Icons.people_outline, size: 48), const SizedBox(height: 12), Text(l.noCustomers)])),
        for (final item in items) Card(child: ListTile(
          title: Text(item['displayName'] as String), subtitle: Text(item['phoneE164'] as String),
          onTap: busy || !canWrite ? null : () => edit(item),
          trailing: canWrite ? IconButton(tooltip: l.archiveCustomer, icon: const Icon(Icons.archive_outlined), onPressed: busy ? null : () => archive(item)) : null,
        )),
        if (next != null) TextButton(onPressed: busy ? null : () => load(more: true), child: Text(l.loadMore)),
      ]))),
    );
  }
}

class CustomerEditor extends StatefulWidget {
  const CustomerEditor({super.key, required this.api, required this.path, this.customer});
  final IdentityApi api;
  final String path;
  final Map<String, dynamic>? customer;
  @override
  State<CustomerEditor> createState() => _CustomerEditorState();
}

class _CustomerEditorState extends State<CustomerEditor> {
  final form = GlobalKey<FormState>();
  late final TextEditingController name;
  late final TextEditingController phone;
  late final TextEditingController email;
  late final TextEditingController notes;
  late String language;
  bool busy = false;
  int? error;
  @override
  void initState() {
    super.initState();
    name = TextEditingController(text: widget.customer?['displayName'] as String?);
    phone = TextEditingController(text: widget.customer?['phoneE164'] as String?);
    email = TextEditingController(text: widget.customer?['email'] as String?);
    notes = TextEditingController(text: widget.customer?['notes'] as String?);
    language = widget.customer?['language'] as String? ?? 'pt';
  }
  @override
  void dispose() { for (final c in [name, phone, email, notes]) { c.dispose(); } super.dispose(); }
  Future<void> save() async {
    if (!form.currentState!.validate()) return;
    setState(() { busy = true; error = null; });
    try {
      await widget.api.request(widget.customer == null ? 'POST' : 'PUT', '${widget.path}${widget.customer == null ? '' : '/${widget.customer!['id']}'}', {
        'displayName': name.text.trim(), 'phoneE164': phone.text.trim(), 'language': language,
        'email': email.text.trim().isEmpty ? null : email.text.trim(), 'notes': notes.text.isEmpty ? null : notes.text,
      });
      if (mounted) Navigator.pop(context, true);
    } catch (e) { if (mounted) setState(() { busy = false; error = e is ApiFailure ? e.status : 0; }); }
  }
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return PopScope(canPop: !busy, child: AlertDialog(
      title: Text(widget.customer == null ? l.addCustomer : l.editCustomer),
      content: SizedBox(width: 480, child: SingleChildScrollView(child: Form(key: form, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextFormField(controller: name, enabled: !busy, maxLength: 160, decoration: InputDecoration(labelText: l.customerName), validator: (v) => v == null || v.trim().isEmpty ? l.invalidField : null),
        TextFormField(controller: phone, enabled: !busy, maxLength: 16, keyboardType: TextInputType.phone, decoration: InputDecoration(labelText: l.customerPhone), validator: (v) => RegExp(r'^\+[1-9]\d{6,14}$').hasMatch(v?.trim() ?? '') ? null : l.invalidField),
        TextFormField(controller: email, enabled: !busy, maxLength: 254, keyboardType: TextInputType.emailAddress, decoration: InputDecoration(labelText: l.email)),
        DropdownButtonFormField<String>(initialValue: language, decoration: InputDecoration(labelText: l.language), items: ['pt', 'en', 'es', 'fr', 'de', 'it'].map((s) => DropdownMenuItem(value: s, child: Text(s))).toList(), onChanged: busy ? null : (v) { if (v != null) setState(() => language = v); }),
        const SizedBox(height: 16),
        TextFormField(controller: notes, enabled: !busy, maxLength: 4000, minLines: 2, maxLines: 4, decoration: InputDecoration(labelText: l.customerNotes)),
        if (error != null) Text(error == 409 ? l.customerDuplicate : l.actionError, style: TextStyle(color: Theme.of(context).colorScheme.error)),
        if (busy) const LinearProgressIndicator(),
      ])))),
      actions: [TextButton(onPressed: busy ? null : () => Navigator.pop(context), child: Text(l.close)), FilledButton(onPressed: busy ? null : save, child: Text(l.saveCustomer))],
    ));
  }
}
