import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'connection.dart';
import 'channels/channels_page.dart';
import 'channels/simulation_page.dart';
import 'conversations/conversations_page.dart';
import 'customers/customers_page.dart';
import 'quarantine/quarantine_page.dart';
import 'identity/account_page.dart';
import 'onboarding/onboarding_page.dart';
import 'l10n/generated/app_localizations.dart';

final localeProvider = StateProvider<Locale?>((ref) => null);
final routerProvider = Provider<GoRouter>((ref) {
  final router = GoRouter(routes: [
    GoRoute(path: '/channels/:tenantId/:channelId/simulate', builder: (context, state) => SimulationPage(key: ValueKey('${state.pathParameters['tenantId']}/${state.pathParameters['channelId']}'), tenantId: state.pathParameters['tenantId']!, channelId: state.pathParameters['channelId']!)),
    GoRoute(path: '/channels/:tenantId', builder: (context, state) => ChannelsPage(key: ValueKey(state.pathParameters['tenantId']), tenantId: state.pathParameters['tenantId']!)),
    GoRoute(path: '/quarantine/:tenantId', builder: (context, state) => QuarantinePage(key: ValueKey(state.pathParameters['tenantId']), tenantId: state.pathParameters['tenantId']!)),
    GoRoute(path: '/conversations/:tenantId', builder: (context, state) => ConversationsPage(key: ValueKey(state.pathParameters['tenantId']), tenantId: state.pathParameters['tenantId']!)),
    GoRoute(path: '/customers/:tenantId', builder: (context, state) => CustomersPage(tenantId: state.pathParameters['tenantId']!)),
    GoRoute(path: '/account', builder: (context, state) => AccountPage(action: state.uri.queryParameters['action'], token: state.uri.queryParameters['token'], tenant: state.uri.queryParameters['tenant'])),
    GoRoute(path: '/onboarding/:tenantId', builder: (context, state) =>
      OnboardingPage(tenantId: state.pathParameters['tenantId']!)),
    GoRoute(path: '/', builder: (context, state) => const WorkspacePage()),
    GoRoute(
      path: '/connection',
      builder: (context, state) => const WorkspacePage(connection: true),
    ),
  ]);
  ref.onDispose(router.dispose);
  return router;
});

class MelissaApp extends ConsumerWidget {
  const MelissaApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      title: 'Melissa',
      debugShowCheckedModeBanner: false,
      locale: ref.watch(localeProvider),
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF4255B5)),
        scaffoldBackgroundColor: const Color(0xFFF6F7FB),
        inputDecorationTheme: const InputDecorationTheme(
          border: OutlineInputBorder(),
        ),
      ),
      routerConfig: ref.watch(routerProvider),
    );
  }
}

class WorkspacePage extends ConsumerWidget {
  const WorkspacePage({super.key, this.connection = false});
  final bool connection;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context)!;
    final wide = MediaQuery.sizeOf(context).width >= 800;
    void navigate(int index) => context.go(index == 0 ? '/' : '/connection');
    return Scaffold(
      appBar: AppBar(
        title: const Text('Melissa'),
        actions: [
          IconButton(tooltip: l.account, onPressed: () => context.go('/account'), icon: const Icon(Icons.account_circle_outlined)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: DropdownButton<Locale>(
              value: Localizations.localeOf(context),
              underline: const SizedBox.shrink(),
              hint: Text(l.language),
              onChanged: (value) {
                if (value != null) ref.read(localeProvider.notifier).state = value;
              },
              items: AppLocalizations.supportedLocales
                  .map((locale) => DropdownMenuItem(
                        value: locale,
                        child: Text(locale.languageCode.toUpperCase()),
                      ))
                  .toList(),
            ),
          ),
        ],
      ),
      body: Row(children: [
        if (wide)
          NavigationRail(
            selectedIndex: connection ? 1 : 0,
            onDestinationSelected: navigate,
            labelType: NavigationRailLabelType.all,
            destinations: [
              NavigationRailDestination(
                icon: const Icon(Icons.space_dashboard_outlined),
                label: Text(l.overview),
              ),
              NavigationRailDestination(
                icon: const Icon(Icons.cloud_outlined),
                label: Text(l.connection),
              ),
            ],
          ),
        Expanded(
          child: SingleChildScrollView(
            padding: EdgeInsets.all(wide ? 40 : 20),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 960),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      connection ? l.connection : l.welcome,
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 12),
                    Text(connection ? l.connectionDescription : l.subtitle),
                    const SizedBox(height: 28),
                    if (!connection) ...[
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Icon(Icons.auto_awesome_outlined, size: 32),
                              const SizedBox(height: 16),
                              Text(l.workspaceTitle,
                                  style: Theme.of(context).textTheme.titleLarge),
                              const SizedBox(height: 12),
                              Text(l.workspaceDescription),
                              const SizedBox(height: 16),
                              FilledButton.tonal(
                                onPressed: () => context.go('/account'),
                                child: Text(l.account),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 20),
                    ],
                    const ConnectionCard(),
                  ],
                ),
              ),
            ),
          ),
        ),
      ]),
      bottomNavigationBar: wide
          ? null
          : NavigationBar(
              selectedIndex: connection ? 1 : 0,
              onDestinationSelected: navigate,
              destinations: [
                NavigationDestination(
                  icon: const Icon(Icons.space_dashboard_outlined),
                  label: l.overview,
                ),
                NavigationDestination(
                  icon: const Icon(Icons.cloud_outlined),
                  label: l.connection,
                ),
              ],
            ),
    );
  }
}

class ConnectionCard extends ConsumerWidget {
  const ConnectionCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context)!;
    final state = ref.watch(connectionProvider);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: state.when(
          loading: () => Row(children: [
            const SizedBox(
              width: 24, height: 24,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: 16),
            Expanded(child: Text(l.connecting)),
          ]),
          data: (ready) => _result(context, ref, ready),
          error: (error, stack) => _result(context, ref, false),
        ),
      ),
    );
  }

  Widget _result(BuildContext context, WidgetRef ref, bool ready) {
    final l = AppLocalizations.of(context)!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(children: [
          Icon(ready ? Icons.check_circle_outline : Icons.cloud_off_outlined),
          const SizedBox(width: 12),
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: Text(ready ? l.connected : l.unavailable),
            ),
          ),
        ]),
        const SizedBox(height: 12),
        Text(ready ? l.readyDescription : l.retryDescription),
        const SizedBox(height: 16),
        OutlinedButton.icon(
          onPressed: () => ref.invalidate(connectionProvider),
          icon: const Icon(Icons.refresh),
          label: Text(l.retry),
        ),
      ],
    );
  }
}
