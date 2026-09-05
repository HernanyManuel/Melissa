import 'dart:convert';
import 'package:http/http.dart' as http;
import 'client.dart';

class ApiFailure implements Exception {
  const ApiFailure(this.status, {this.retryAfterSeconds});
  final int status;
  final int? retryAfterSeconds;
}

class IdentityApi {
  IdentityApi({http.Client? client}) : _client = client ?? createClient();
  final http.Client _client;
  String? _access;
  String? _csrf;
  Future<void>? _refreshing;
  static const base = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:3000');
  bool get authenticated => _access != null;
  void dispose() => _client.close();
  void clear() { _access = null; _csrf = null; }

  Future<Object?> request(String method, String path, [Map<String, Object?>? body, bool retry = true]) async {
    final req = http.Request(method, Uri.parse('$base/api/v1$path'));
    req.headers['Content-Type'] = 'application/json';
    if (_access != null) req.headers['Authorization'] = 'Bearer $_access';
    if (_csrf != null) req.headers['X-CSRF-Token'] = _csrf!;
    if (body != null) req.body = jsonEncode(body);
    final response = await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 15)));
    if (response.statusCode == 401 && retry && !path.startsWith('/auth/')) {
      await refresh();
      return request(method, path, body, false);
    }
    if (response.statusCode >= 400) {
      final retryAfter = int.tryParse(response.headers['retry-after'] ?? '');
      throw ApiFailure(response.statusCode, retryAfterSeconds: retryAfter != null && retryAfter > 0 ? retryAfter.clamp(1, 3600).toInt() : null);
    }
    return response.body.isEmpty ? null : jsonDecode(response.body);
  }
  Future<void> login(String email, String password) async {
    final data = await request('POST', '/auth/login', {'email': email, 'password': password}) as Map<String, dynamic>;
    _access = data['access_token'] as String;
    _csrf = data['csrf_token'] as String;
  }
  Future<void> refresh() => _refreshing ??= _refresh().whenComplete(() => _refreshing = null);
  Future<void> _refresh() async {
    try {
      final csrf = await request('GET', '/auth/csrf') as Map<String, dynamic>;
      _csrf = csrf['csrf_token'] as String;
      final data = await request('POST', '/auth/refresh') as Map<String, dynamic>;
      _access = data['access_token'] as String;
      _csrf = data['csrf_token'] as String;
    } catch (_) { clear(); rethrow; }
  }
  Future<void> logout() async {
    // Keep state on network failure so the user can retry server-side revocation.
    try { await request('POST', '/auth/logout'); }
    on ApiFailure catch (error) {
      if (error.status != 401) rethrow;
      await refresh();
      await request('POST', '/auth/logout');
    }
    clear();
  }
}
