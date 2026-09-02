import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';
import 'package:melissa/onboarding/onboarding_page.dart';

void main() {
  testWidgets('onboarding is a localized step-by-step wizard', (tester) async {
    tester.view.physicalSize = const Size(390, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = IdentityApi(client: MockClient((request) async {
      if (request.url.path.endsWith('/csrf')) return http.Response('{"csrf_token":"csrf"}', 200);
      if (request.url.path.endsWith('/refresh')) return http.Response('{"access_token":"access","csrf_token":"next"}', 200);
      if (request.url.path.endsWith('/industry-templates')) return http.Response('[{"key":"generic","name":"Outro","description":"Geral"}]', 200);
      if (request.url.path.endsWith('/services')) return http.Response('[]', 200);
      if (request.url.path.endsWith('/faqs')) return http.Response('[]', 200);
      return http.Response('{}', 200);
    }));
    await tester.pumpWidget(MaterialApp(
      locale: const Locale('pt'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: OnboardingPage(tenantId: '00000000-0000-4000-8000-000000000001', api: api),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Configurar empresa'), findsOneWidget);
    expect(find.text('Empresa'), findsOneWidget);
    expect(find.text('Guardar e continuar'), findsOneWidget);
    expect(find.text('Ativar Assistente'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
