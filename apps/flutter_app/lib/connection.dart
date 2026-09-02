import 'dart:convert';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

const apiUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://localhost:3000',
);

final connectionProvider = FutureProvider.autoDispose<bool>((ref) async {
  final client = http.Client();
  ref.onDispose(client.close);
  final response = await client
      .get(Uri.parse('$apiUrl/health/ready'))
      .timeout(const Duration(seconds: 5));
  if (response.statusCode != 200) return false;
  final body = jsonDecode(response.body);
  return body is Map<String, dynamic> && body['status'] == 'ok';
});
