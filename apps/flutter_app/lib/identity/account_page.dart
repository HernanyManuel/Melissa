import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../l10n/generated/app_localizations.dart';
import 'api.dart';

class AccountPage extends StatefulWidget {
  const AccountPage({super.key, this.action, this.token, this.tenant, this.api});
  final IdentityApi? api;
  final String? action;
  final String? token;
  final String? tenant;
  @override
  State<AccountPage> createState() => _AccountPageState();
}

class _AccountPageState extends State<AccountPage> {
  late final IdentityApi api;
  bool termsAccepted = false;
  final form = GlobalKey<FormState>();
  final email = TextEditingController();
  final password = TextEditingController();
  final name = TextEditingController();
  final country = TextEditingController(text: 'PT');
  final timezone = TextEditingController(text: 'Europe/Lisbon');
  String mode = 'login';
  bool busy = true;
  String? notice;
  bool failed = false;
  List<Map<String, dynamic>> tenants = [];
  Map<String, dynamic>? selected;
  List<Map<String, dynamic>> members = [];
  String inviteRole = 'viewer';
  @override
  void initState() {
    super.initState();
    api = widget.api ?? IdentityApi();
    mode = widget.action == 'reset' ? 'reset' : 'login';
    if (widget.action == 'reset') { busy = false; } else { restore(); }
  }
  Future<void> restore() async {
    try { await api.refresh(); await loadTenants(); } catch (_) { api.clear(); }
    if (mounted) setState(() => busy = false);
  }
  @override
  void dispose() { api.dispose(); email.dispose(); password.dispose(); name.dispose(); country.dispose(); timezone.dispose(); super.dispose(); }
  Future<void> loadTenants() async {
    tenants = (await api.request('GET', '/tenants') as List).cast<Map<String, dynamic>>();
    selected = null; members = [];
  }
  Future<void> run(Future<void> Function() action, {bool validate = false}) async {
    if (busy || (validate && !form.currentState!.validate())) return;
    setState(() { busy = true; notice = null; failed = false; });
    try { await action(); }
    catch (error) {
      if (mounted) {
        final l = AppLocalizations.of(context)!;
        notice = error is ApiFailure && error.status == 401 ? l.loginError : l.actionError;
        failed = true;
        if (!api.authenticated) { tenants = []; selected = null; members = []; }
      }
    }
    if (mounted) setState(() => busy = false);
  }
  Widget field(TextEditingController controller, String label, {bool secret = false, bool isEmail = false}) {
    final l = AppLocalizations.of(context)!;
    return Padding(padding: const EdgeInsets.only(bottom: 16), child: TextFormField(
      controller: controller, enabled: !busy, obscureText: secret,
      keyboardType: isEmail ? TextInputType.emailAddress : TextInputType.text,
      autocorrect: !secret && !isEmail,
      autofillHints: secret ? [AutofillHints.password] : isEmail ? [AutofillHints.email] : null,
      decoration: InputDecoration(labelText: label),
      validator: (value) => value == null || value.trim().isEmpty || (secret && (value.length < 12 || value.length > 128)) || (isEmail && !value.contains('@')) ? l.invalidField : null,
    ));
  }
  Future<void> submit() async {
    final l = AppLocalizations.of(context)!;
    if (mode == 'login') { await api.login(email.text.trim(), password.text); password.clear(); await loadTenants(); }
    else if (mode == 'register') { await api.request('POST', '/auth/register', {'email':email.text.trim(),'password':password.text,'name':name.text.trim(),'termsAccepted':termsAccepted}); password.clear(); notice = l.checkEmail; mode = 'login'; }
    else if (mode == 'reset') { await api.request('POST','/auth/reset-password',{'token':widget.token,'password':password.text}); password.clear(); notice = l.passwordUpdated; mode = 'login'; }
    else { await api.request('POST', '/auth/forgot-password', {'email':email.text.trim()}); notice = l.checkEmail; }
  }
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(title: Text(l.account), leading: IconButton(icon: const Icon(Icons.arrow_back), tooltip: l.overview, onPressed: () => context.go('/'))),
      body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 640), child: SingleChildScrollView(
        padding: const EdgeInsets.all(24), child: AutofillGroup(child: Form(key: form, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (busy) const LinearProgressIndicator(),
          const SizedBox(height: 16),
          if (notice != null) Semantics(liveRegion: true, child: Padding(padding: const EdgeInsets.only(bottom: 20), child: Text(notice!, style: TextStyle(color: failed ? Theme.of(context).colorScheme.error : null)))),
          if (widget.action == 'verify') ...[
            Text(l.verifyEmail, style: Theme.of(context).textTheme.headlineSmall),
            FilledButton(onPressed: busy ? null : () => run(() async { await api.request('POST','/auth/verify',{'token':widget.token}); notice = l.emailVerified; }), child: Text(l.verifyEmail)),
            const SizedBox(height: 24),
          ],
          if (!api.authenticated) ...[
            Text(mode == 'register' ? l.register : mode == 'forgot' ? l.forgotPassword : mode == 'reset' ? l.resetPassword : l.signIn, style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 24),
            if (mode == 'register') ...[field(name, l.yourName), CheckboxListTile(value: termsAccepted, onChanged: busy ? null : (value) => setState(() => termsAccepted = value ?? false), title: Text(l.acceptTerms)), TextButton(onPressed: () => showDialog<void>(context: context, builder: (context) => AlertDialog(title: Text(l.termsTitle), content: Text(l.termsBody), actions: [TextButton(onPressed: () => Navigator.pop(context), child: Text(l.close))])), child: Text(l.termsTitle))],
            if (mode != 'reset') field(email, l.email, isEmail: true),
            if (mode != 'forgot') field(password, l.password, secret: true),
            FilledButton(onPressed: busy || (mode == 'register' && !termsAccepted) ? null : () => run(submit, validate: true), child: Text(mode == 'register' ? l.register : mode == 'forgot' ? l.sendLink : mode == 'reset' ? l.resetPassword : l.signIn)),
            TextButton(onPressed: busy ? null : () => setState(() { mode = mode == 'register' ? 'login' : 'register'; notice = null; }), child: Text(mode == 'register' ? l.signIn : l.register)),
            TextButton(onPressed: busy ? null : () => setState(() { mode = 'forgot'; notice = null; }), child: Text(l.forgotPassword)),
            TextButton(onPressed: busy ? null : () => run(() async { await api.request('POST','/auth/resend-verification',{'email':email.text.trim()}); notice = l.checkEmail; }), child: Text(l.resendVerification)),
          ] else ...[
            Row(children: [Expanded(child: Text(l.yourBusinesses, style: Theme.of(context).textTheme.headlineSmall)), IconButton(tooltip: l.signOut, onPressed: busy ? null : () => run(() async { await api.logout(); tenants = []; selected = null; members = []; }), icon: const Icon(Icons.logout))]),
            if (widget.action == 'invite') FilledButton(onPressed: busy ? null : () => run(() async { await api.request('POST','/tenants/${widget.tenant}/invitations/accept',{'token':widget.token}); await loadTenants(); notice = l.inviteAccepted; }), child: Text(l.acceptInvite)),
            if (tenants.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 20), child: Text(l.noBusinesses)),
            for (final item in tenants) Card(child: ListTile(
              selected: selected?['id'] == item['tenant']['id'], leading: const Icon(Icons.business_outlined), title: Text(item['tenant']['name'] as String), subtitle: Text(roleLabel(l, item['role'] as String)),
              onTap: busy ? null : () => run(() async {
                selected = null; members = []; inviteRole = 'viewer';
                final id = item['tenant']['id'];
                final detail = await api.request('GET','/tenants/$id') as Map<String,dynamic>;
                if (item['role'] == 'owner' || item['role'] == 'admin') members = (await api.request('GET','/tenants/$id/memberships') as List).cast<Map<String,dynamic>>();
                selected = {...detail, 'role':item['role']};
              }),
            )),
            if (selected != null) ...[
              const Divider(height: 32),
              Text('${l.selectedBusiness}: ${selected!['name']}'),
              if (selected!['role'] == 'owner' || selected!['role'] == 'admin') OutlinedButton.icon(
                onPressed: busy ? null : () => context.go('/quarantine/${selected!['id']}'),
                icon: const Icon(Icons.shield_outlined), label: Text(l.quarantine),
              ),
              if (selected!['role'] != 'viewer') OutlinedButton.icon(
                onPressed: busy ? null : () => context.go('/conversations/${selected!['id']}'),
                icon: const Icon(Icons.chat_bubble_outline), label: Text(l.conversations),
              ),
              if (selected!['role'] != 'viewer') OutlinedButton.icon(
                onPressed: busy ? null : () => context.go('/customers/${selected!['id']}'),
                icon: const Icon(Icons.people_outline), label: Text(l.customers),
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: busy ? null : () => context.go('/onboarding/${selected!['id']}'),
                icon: const Icon(Icons.checklist_outlined),
                label: Text(l.configureBusiness),
              ),
              if (selected!['role'] == 'owner' || selected!['role'] == 'admin') ...[
                const SizedBox(height: 16), Text(l.team, style: Theme.of(context).textTheme.titleLarge),
                for (final member in members) ListTile(title: Text(member['user']['name'] as String), subtitle: Text('${member['user']['email']} · ${roleLabel(l, member['role'] as String)}'), trailing: member['role'] == 'owner' || (selected!['role'] == 'admin' && member['role'] == 'admin') ? null : Switch(value: member['active'] as bool, onChanged: busy ? null : (value) => run(() async {
                  final id = selected!['id'];
                  await api.request('PATCH','/tenants/$id/memberships/${member['id']}',{'role':member['role'],'active':value});
                  await loadTenants();
                }))),
                field(email, l.inviteEmail, isEmail: true),
                DropdownButtonFormField<String>(initialValue: inviteRole, items: ['viewer','staff','manager',if(selected!['role']=='owner') 'admin'].map((role) => DropdownMenuItem(value:role,child:Text(roleLabel(l,role)))).toList(), onChanged: busy ? null : (value) => setState(() => inviteRole = value!), decoration: InputDecoration(labelText:l.role)),
                const SizedBox(height: 16),
                OutlinedButton(onPressed: busy ? null : () => run(() async { await api.request('POST','/tenants/${selected!['id']}/invitations',{'email':email.text.trim(),'role':inviteRole}); notice = l.checkEmail; }), child: Text(l.inviteMember)),
              ],
            ],
            const Divider(height: 40), Text(l.createBusiness, style: Theme.of(context).textTheme.titleLarge), const SizedBox(height: 16),
            field(name, l.businessName), field(country, l.countryCode), field(timezone, l.timezone),
            FilledButton.icon(onPressed: busy ? null : () => run(() async { await api.request('POST','/tenants',{'name':name.text.trim(),'countryCode':country.text.trim().toUpperCase(),'timezone':timezone.text.trim()}); name.clear(); await loadTenants(); }), icon: const Icon(Icons.add), label: Text(l.createBusiness)),
          ],
        ]))),
      ))),
    );
  }
}
String roleLabel(AppLocalizations l, String role) => switch(role) { 'owner' => l.roleOwner, 'admin' => l.roleAdmin, 'manager' => l.roleManager, 'staff' => l.roleStaff, _ => l.roleViewer };
