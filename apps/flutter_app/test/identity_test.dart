import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:melissa/identity/api.dart';
import 'package:melissa/identity/account_page.dart';
import 'package:melissa/l10n/generated/app_localizations.dart';

void main() {
  test('concurrent refresh requests share one rotation', () async {
    var rotations = 0;
    final api = IdentityApi(client: MockClient((req) async {
      if (req.url.path.endsWith('/csrf')) return http.Response('{"csrf_token":"csrf"}', 200);
      rotations++;
      await Future<void>.delayed(const Duration(milliseconds: 5));
      expect(req.headers['X-CSRF-Token'], 'csrf');
      return http.Response('{"access_token":"access","csrf_token":"next"}', 200);
    }));
    addTearDown(api.dispose);
    await Future.wait([api.refresh(), api.refresh(), api.refresh()]);
    expect(rotations, 1);
    expect(api.authenticated, isTrue);
  });
  test('logout failure preserves session for retry and success clears it', () async {
    var fail = true;
    final api = IdentityApi(client: MockClient((req) async {
      if (req.url.path.endsWith('/login')) return http.Response('{"access_token":"access","csrf_token":"csrf"}', 200);
      return http.Response('', fail ? 503 : 204);
    }));
    addTearDown(api.dispose);
    await api.login('person@example.test', 'long-password');
    await expectLater(api.logout(), throwsA(isA<ApiFailure>()));
    expect(api.authenticated, isTrue);
    fail = false;
    await api.logout();
    expect(api.authenticated, isFalse);
  });
  testWidgets('account requires consent and renders at a narrow viewport', (tester) async {
    tester.view.physicalSize = const Size(360, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = IdentityApi(client: MockClient((req) async => http.Response(jsonEncode({'error':'test'}),401)));
    await tester.pumpWidget(MaterialApp(
      locale: const Locale('en'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: AccountPage(api: api),
    ));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create account'));
    await tester.pumpAndSettle();
    final button = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Create account'));
    expect(button.onPressed, isNull);
    expect(find.text('I accept the development terms'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
