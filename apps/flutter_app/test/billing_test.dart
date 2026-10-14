import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/billing/billing_page.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

Widget page(IdentityApi api, {String tenantId = 'tenant-a', Locale locale = const Locale('pt')}) =>
    MaterialApp(
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: BillingPage(key: ValueKey(tenantId), tenantId: tenantId, api: api),
    );

Future<IdentityApi> authenticatedApi(
  Future<http.Response> Function(http.Request) handler,
) async {
  final api = IdentityApi(client: MockClient((request) async {
    if (request.url.path.endsWith('/auth/login')) {
      return http.Response('{"access_token":"test-access","csrf_token":"test-csrf"}', 200);
    }
    return handler(request);
  }));
  await api.login('owner@example.test', 'test-password-long');
  return api;
}

final plans = {
  'items': [
    {
      'id': 'plan-1',
      'key': 'standard',
      'name': 'Plano de exemplo',
      'currency': 'EUR',
      'basePrice': '24.99',
      'billingInterval': 'month',
      'includedConversations': 200,
      'includedStaff': 2,
      'includedChannels': 1,
      'includedLocations': 1,
    }
  ],
};

Map<String, Object?> subscription({Object? value}) => {
  'subscription': value,
  'entitlements': {
    'automationEnabled': false,
    'billingVerified': false,
    'reason': 'billing_not_enabled',
  },
};

void main() {
  testWidgets('billing lists DB-backed plans and no subscription, without purchase actions', (tester) async {
    tester.view.physicalSize = const Size(360, 850);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final requested = <http.Request>[];
    final api = await authenticatedApi((request) async {
      requested.add(request);
      if (request.url.path.endsWith('/billing/plans')) {
        return http.Response(jsonEncode(plans), 200);
      }
      if (request.url.path.endsWith('/billing/subscription')) {
        return http.Response(jsonEncode(subscription()), 200);
      }
      return http.Response('{}', 404);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(page(api));
    await tester.pumpAndSettle();
    expect(find.text('Faturação'), findsOneWidget);
    expect(find.text('Plano de exemplo'), findsOneWidget);
    expect(find.text('EUR 24.99 / mês'), findsOneWidget);
    expect(find.text('Conversas incluídas: 200'), findsOneWidget);
    expect(find.text('Ainda não existe uma subscrição associada a esta empresa.'), findsOneWidget);
    expect(find.byKey(const Key('billing-inactive-notice')), findsOneWidget);
    expect(find.textContaining('automação paga permanece desativada'), findsOneWidget);
    expect(find.textContaining('Contratar'), findsNothing);
    expect(find.textContaining('Pagar'), findsNothing);
    expect(requested.length, 2);
    expect(requested.every((r) => r.method == 'GET' &&
        r.url.path.startsWith('/api/v1/tenants/tenant-a/billing/')), isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('billing shows current subscription without claiming verified entitlements', (tester) async {
    final api = await authenticatedApi((request) async {
      if (request.url.path.endsWith('/billing/plans')) {
        return http.Response(jsonEncode({'items': []}), 200);
      }
      return http.Response(jsonEncode(subscription(value: {
        'id': 'sub-local',
        'provider': 'stripe',
        'status': 'active',
        'cancelAtPeriodEnd': true,
        'currentPeriodStart': '2026-10-01T12:00:00.000Z',
        'currentPeriodEnd': '2026-11-01T12:00:00.000Z',
        'plan': {'name': 'Plano contratado'},
      })), 200);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(page(api, locale: const Locale('en')));
    await tester.pumpAndSettle();
    expect(find.text('Status: active'), findsOneWidget);
    expect(find.text('Plano contratado'), findsOneWidget);
    expect(find.textContaining('Current period:'), findsOneWidget);
    expect(find.text('Cancel at period end'), findsOneWidget);
    expect(find.text('No plans have been published.'), findsOneWidget);
    expect(find.textContaining('Paid automation remains disabled'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('403 on subscription hides plan data, and successful retry restores it', (tester) async {
    var blocked = true;
    final api = await authenticatedApi((request) async {
      if (request.url.path.endsWith('/billing/plans')) {
        return http.Response(jsonEncode(plans), 200);
      }
      return blocked
          ? http.Response('{"error":"Forbidden"}', 403)
          : http.Response(jsonEncode(subscription()), 200);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(page(api));
    await tester.pumpAndSettle();
    expect(find.text('Plano de exemplo'), findsNothing);
    expect(find.text('Não tens acesso à faturação desta empresa.'), findsOneWidget);
    blocked = false;
    await tester.tap(find.byKey(const Key('billing-refresh')));
    await tester.pumpAndSettle();
    expect(find.text('Plano de exemplo'), findsOneWidget);
    expect(find.byKey(const Key('billing-error')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('unexpected entitlement permission fails closed and no prices are shown', (tester) async {
    final api = await authenticatedApi((request) async {
      if (request.url.path.endsWith('/billing/plans')) {
        return http.Response(jsonEncode(plans), 200);
      }
      return http.Response(jsonEncode({
        'subscription': {'status': 'active'},
        'entitlements': {'automationEnabled': true, 'billingVerified': true},
      }), 200);
    });
    addTearDown(api.dispose);
    await tester.pumpWidget(page(api, locale: const Locale('en')));
    await tester.pumpAndSettle();
    expect(find.text('Plano de exemplo'), findsNothing);
    expect(find.textContaining('Unable to load billing'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
