import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:melissa/app.dart';
import 'package:melissa/connection.dart';

void main() {
  testWidgets('shows real readiness state at a narrow viewport', (tester) async {
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(ProviderScope(
      overrides: [
        localeProvider.overrideWith((ref) => const Locale('en')),
        connectionProvider.overrideWith((ref) async => true),
      ],
      child: const MelissaApp(),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Welcome to Melissa'), findsOneWidget);
    expect(find.text('Service connected'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('error state offers retry without exposing exception', (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [
        localeProvider.overrideWith((ref) => const Locale('en')),
        connectionProvider.overrideWith((ref) async => throw Exception('secret')),
      ],
      child: const MelissaApp(),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Service unavailable'), findsOneWidget);
    expect(find.textContaining('secret'), findsNothing);
    expect(find.text('Refresh'), findsOneWidget);
  });

  testWidgets('Portuguese resources render without overflow', (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [
        localeProvider.overrideWith((ref) => const Locale('pt')),
        connectionProvider.overrideWith((ref) async => false),
      ],
      child: const MelissaApp(),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Bem-vindo à Melissa'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
