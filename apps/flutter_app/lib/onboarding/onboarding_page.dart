import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../identity/api.dart';
import '../l10n/generated/app_localizations.dart';

class OnboardingPage extends StatefulWidget {
  const OnboardingPage({super.key, required this.tenantId, this.api});
  final String tenantId;
  final IdentityApi? api;
  @override State<OnboardingPage> createState() => _OnboardingPageState();
}

class _OnboardingPageState extends State<OnboardingPage> {
  late final IdentityApi api;
  var step = 0;
  var busy = true;
  String? error;
  List<Map<String, dynamic>> templates = [];
  List<Map<String, dynamic>> services = [];
  final name = TextEditingController();
  final city = TextEditingController();
  final serviceName = TextEditingController();
  final price = TextEditingController(text: '18.00');
  final duration = TextEditingController(text: '30');
  final faqQuestion = TextEditingController();
  final faqAnswer = TextEditingController();
  final staffName = TextEditingController();
  final policy = TextEditingController();
  String industry = 'generic';
  String country = 'PT';
  String timezone = 'Europe/Lisbon';
  String locale = 'pt';
  String currency = 'EUR';
  String tone = 'friendly';
  bool useEmojis = false;
  final periods = <Map<String, Object>>[
    for (var day = 1; day <= 5; day++)
      {'weekday': day, 'startTime': '09:00', 'endTime': '19:00', 'enabled': true},
    {'weekday': 6, 'startTime': '09:00', 'endTime': '14:00', 'enabled': true},
  ];
  @override void initState() { super.initState(); api = widget.api ?? IdentityApi(); load(); }
  Future<void> load() async {
    try {
      await api.refresh();
      templates = (await api.request('GET', '/industry-templates') as List).cast<Map<String,dynamic>>();
      services = (await api.request('GET', '/tenants/${widget.tenantId}/services') as List).cast<Map<String,dynamic>>();
    } catch (_) { error = 'load'; }
    if (mounted) setState(() => busy = false);
  }
  @override void dispose() {
    api.dispose();
    for (final item in [name,city,serviceName,price,duration,faqQuestion,faqAnswer,staffName,policy]) { item.dispose(); }
    super.dispose();
  }
  Future<void> run(Future<void> Function() work, {bool next = false}) async {
    setState(() { busy = true; error = null; });
    try { await work(); if (next && step < 5) step++; }
    catch (_) { error = 'action'; }
    if (mounted) setState(() => busy = false);
  }
  InputDecoration decoration(String label) => InputDecoration(labelText: label);
  Widget text(TextEditingController controller, String label, {TextInputType? type, int lines = 1}) =>
    Padding(padding: const EdgeInsets.only(bottom: 12), child: TextField(
      controller: controller, enabled: !busy, keyboardType: type, maxLines: lines,
      onChanged: (_) => setState(() {}),
      decoration: decoration(label),
    ));
  Widget dropdown(String value, String label, List<String> values, ValueChanged<String> changed) =>
    Padding(padding: const EdgeInsets.only(bottom: 12), child: DropdownButtonFormField<String>(
      initialValue: value, decoration: decoration(label),
      items: values.map((item) => DropdownMenuItem(value: item, child: Text(item))).toList(),
      onChanged: busy ? null : (item) { if (item != null) changed(item); },
    ));
  @override Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final labels = [l.businessDetails,l.servicesSetup,l.hoursSetup,l.staffSetup,l.faqSetup,l.preferencesSetup];
    return Scaffold(
      appBar: AppBar(title: Text(l.configureBusiness), leading: IconButton(
        icon: const Icon(Icons.arrow_back), onPressed: () => context.go('/account'))),
      body: SafeArea(child: Column(children: [
        if (busy) const LinearProgressIndicator(),
        if (error != null) MaterialBanner(
          content: Text(l.actionError), actions: [TextButton(onPressed: load, child: Text(l.retry))]),
        Expanded(child: Stepper(
          currentStep: step, type: MediaQuery.sizeOf(context).width > 760 ? StepperType.horizontal : StepperType.vertical,
          onStepTapped: busy ? null : (value) => setState(() => step = value),
          controlsBuilder: (_, details) => const SizedBox.shrink(),
          steps: List.generate(labels.length, (index) => Step(
            title: Text(labels[index]), isActive: index <= step,
            state: index < step ? StepState.complete : StepState.indexed,
            content: index == step ? ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 720), child: _content(index, l)) : const SizedBox.shrink(),
          )),
        )),
      ])),
    );
  }
  Widget _content(int index, AppLocalizations l) {
    if (index == 0) return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      text(name,l.businessName), text(city,l.city),
      dropdown(industry,l.businessType,templates.map((item)=>item['key'] as String).toList(),(v)=>setState(()=>industry=v)),
      dropdown(country,l.countryCode,['PT','BR','ES','FR','DE','IT','GB','US'],(v)=>setState(()=>country=v)),
      dropdown(timezone,l.timezone,['Europe/Lisbon','Europe/Madrid','Europe/Paris','Europe/Berlin','Europe/Rome','America/Sao_Paulo'],(v)=>setState(()=>timezone=v)),
      dropdown(locale,l.primaryLanguage,['pt','en','es','fr','de','it'],(v)=>setState(()=>locale=v)),
      dropdown(currency,l.currency,['EUR','BRL','GBP','USD'],(v)=>setState(()=>currency=v)),
      FilledButton(onPressed: busy || name.text.trim().isEmpty || city.text.trim().isEmpty ? null : () => run(() async {
        await api.request('PUT','/tenants/${widget.tenantId}/profile',{'name':name.text.trim(),'industryKey':industry,
          'countryCode':country,'city':city.text.trim(),'timezone':timezone,'locale':locale,'currency':currency});
      },next:true),child:Text(l.saveContinue)),
    ]);
    if (index == 1) return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for(final service in services) Card(child:ListTile(title:Text(service['name'] as String),subtitle:Text('${service['price']} ${service['currency']} · ${service['durationMinutes']} min'))),
      text(serviceName,l.serviceName), text(price,l.price,type:const TextInputType.numberWithOptions(decimal:true)),
      text(duration,l.durationMinutes,type:TextInputType.number),
      FilledButton(onPressed: busy ? null : () => run(() async {
        await api.request('POST','/tenants/${widget.tenantId}/services',{'name':serviceName.text.trim(),'price':price.text,
          'currency':currency,'durationMinutes':int.parse(duration.text),'bufferBeforeMinutes':0,'bufferAfterMinutes':0,
          'bookingEnabled':true,'active':true});
        services=(await api.request('GET','/tenants/${widget.tenantId}/services') as List).cast<Map<String,dynamic>>();
        serviceName.clear();
      }),child:Text(l.addService)),
      TextButton(onPressed: services.isEmpty ? null : ()=>setState(()=>step++),child:Text(l.saveContinue)),
    ]);
    if(index==2) return Column(crossAxisAlignment: CrossAxisAlignment.stretch,children:[
      Text(l.defaultHoursHint),
      const SizedBox(height:12),
      for(final period in periods) ListTile(
        leading:CircleAvatar(child:Text('${period['weekday']}')),
        title:Text('${period['startTime']}–${period['endTime']}'),
        trailing:IconButton(icon:const Icon(Icons.delete_outline),onPressed:busy?null:()=>setState(()=>periods.remove(period)))),
      FilledButton(onPressed:busy||periods.isEmpty?null:()=>run(() async {
        await api.request('PUT','/tenants/${widget.tenantId}/business-hours',{'periods':periods});
      },next:true),child:Text(l.saveContinue)),
    ]);
    if(index==3) return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
      text(staffName,l.staffName),
      Text(l.staffOptionalHint),
      const SizedBox(height:12),
      FilledButton(onPressed:busy||staffName.text.trim().isEmpty?null:()=>run(() async {
        await api.request('POST','/tenants/${widget.tenantId}/staff',{'name':staffName.text.trim(),'active':true,
          'timezone':timezone,'serviceIds':services.map((item)=>item['id']).toList()});
      },next:true),child:Text(l.saveContinue)),
      TextButton(onPressed:busy?null:()=>setState(()=>step++),child:Text(l.skip)),
    ]);
    if(index==4) return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
      text(faqQuestion,l.question),text(faqAnswer,l.answer,lines:3),
      FilledButton(onPressed:busy?null:()=>run(() async {
        await api.request('POST','/tenants/${widget.tenantId}/faqs',{'question':faqQuestion.text.trim(),
          'answer':faqAnswer.text.trim(),'active':true});
      },next:true),child:Text(l.saveContinue)),
    ]);
    return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
      text(policy,l.cancellationPolicy,lines:3),
      dropdown(tone,l.tone,['professional','friendly','informal','premium','concise'],(v)=>setState(()=>tone=v)),
      SwitchListTile(value:useEmojis,onChanged:busy?null:(value)=>setState(()=>useEmojis=value),title:Text(l.useEmojis)),
      FilledButton(onPressed:busy?null:()=>run(() async {
        await api.request('PUT','/tenants/${widget.tenantId}/configuration',{'cancellation':policy.text.trim().isEmpty?null:policy.text.trim(),
          'tone':tone,'useEmojis':useEmojis,'useCustomerName':true,'replyInCustomerLanguage':true,'verbosity':'normal'});
      }),child:Text(l.finishSetup)),
      const SizedBox(height:12),Text(l.activationPending),
    ]);
  }
}
