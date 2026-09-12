import { JsonValue } from './ai-provider';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function assertSafeJson(value: JsonValue, depth = 0): void {
  if (depth > 16) throw new Error('JSON depth exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid JSON number');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('JSON array too large');
    for (const item of value) assertSafeJson(item, depth + 1);
    return;
  }
  if (typeof value !== 'object') throw new Error('Invalid JSON value');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Invalid JSON object');
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error('JSON object too large');
  for (const [key, item] of entries) {
    if (!key || key.length > 128 || FORBIDDEN_KEYS.has(key)) throw new Error('Invalid JSON key');
    assertSafeJson(item, depth + 1);
  }
}
