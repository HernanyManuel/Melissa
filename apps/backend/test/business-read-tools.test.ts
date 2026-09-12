import assert from 'node:assert/strict';
import test from 'node:test';
import { BusinessToolReader } from '../src/ai/business-tool-reader';
import { registerBusinessReadTools } from '../src/ai/business-read-tools';
import { ToolExecutor } from '../src/ai/tool-executor';
import { ToolRegistry } from '../src/ai/tool-registry';

const tenantId = '00000000-0000-4000-8000-000000000001';
const serviceId = '00000000-0000-4000-8000-000000000006';
const calls: Array<{ method: string; tenantId: string; value?: string }> = [];
const reader: BusinessToolReader = {
  async businessInfo(id) {
    calls.push({ method: 'businessInfo', tenantId: id });
    return { found: true, name: 'Barbearia Central' };
  },
  async services(id) {
    calls.push({ method: 'services', tenantId: id });
    return { services: [] };
  },
  async serviceDetails(id, value) {
    calls.push({ method: 'serviceDetails', tenantId: id, value });
    return { found: true, id: value };
  },
  async price(id, value) {
    calls.push({ method: 'price', tenantId: id, value });
    return { found: true, amount: '18', currency: 'EUR' };
  },
  async hours(id, value) {
    calls.push({ method: 'hours', tenantId: id, value });
    return { found: true, date: value, timezone: 'Europe/Lisbon', periods: [] };
  },
  async staff(id) {
    calls.push({ method: 'staff', tenantId: id });
    return { staff: [] };
  },
};

const context = {
  tenantId,
  customerId: '00000000-0000-4000-8000-000000000002',
  conversationId: '00000000-0000-4000-8000-000000000003',
  correlationId: '00000000-0000-4000-8000-000000000004',
  turnId: '00000000-0000-4000-8000-000000000005',
  expectedModeEpoch: 2n,
  executionMode: 'sandbox' as const,
  capabilities: [
    'business.info.read',
    'business.services.read',
    'business.hours.read',
    'business.staff.read',
  ],
};

test('business read tools expose the six server-owned schemas', () => {
  const registry = new ToolRegistry();
  registerBusinessReadTools(registry, reader);
  const names = [
    'get_business_info',
    'get_services',
    'get_service_details',
    'get_price',
    'get_business_hours',
    'get_staff',
  ];
  assert.deepEqual(
    registry.definitions(names).map((item) => item.name),
    names,
  );
  for (const definition of registry.definitions(names))
    assert.equal(definition.inputSchema.additionalProperties, false);
});

test('business read tools derive tenant only from trusted execution context', async () => {
  calls.length = 0;
  const registry = new ToolRegistry();
  registerBusinessReadTools(registry, reader);
  const result = await new ToolExecutor(registry).execute(
    [
      { id: 'c1', name: 'get_business_info', arguments: {} },
      { id: 'c2', name: 'get_services', arguments: {} },
      { id: 'c3', name: 'get_service_details', arguments: { serviceId } },
      { id: 'c4', name: 'get_price', arguments: { serviceId } },
      { id: 'c5', name: 'get_business_hours', arguments: { date: '2026-09-07' } },
      { id: 'c6', name: 'get_staff', arguments: {} },
    ],
    context,
  );
  assert.equal(
    result.every((item) => item.success),
    true,
  );
  assert.equal(calls.length, 6);
  assert.equal(
    calls.every((item) => item.tenantId === tenantId),
    true,
  );
  assert.equal(calls.find((item) => item.method === 'serviceDetails')?.value, serviceId);
});

test('business read validators reject tenant injection, invalid UUIDs and impossible dates', async () => {
  calls.length = 0;
  const registry = new ToolRegistry();
  registerBusinessReadTools(registry, reader);
  const result = await new ToolExecutor(registry).execute(
    [
      { id: 'c1', name: 'get_business_info', arguments: { tenantId } },
      { id: 'c2', name: 'get_price', arguments: { serviceId: 'another-tenant-service' } },
      { id: 'c3', name: 'get_business_hours', arguments: { date: '2026-02-31' } },
    ],
    context,
  );
  assert.deepEqual(
    result.map((item) => item.error),
    ['invalid_arguments', 'invalid_arguments', 'invalid_arguments'],
  );
  assert.equal(calls.length, 0);
});

test('business read capabilities are independently enforced', async () => {
  calls.length = 0;
  const registry = new ToolRegistry();
  registerBusinessReadTools(registry, reader);
  const result = await new ToolExecutor(registry).execute(
    [
      { id: 'c1', name: 'get_business_info', arguments: {} },
      { id: 'c2', name: 'get_services', arguments: {} },
    ],
    { ...context, capabilities: ['business.info.read'] },
  );
  assert.equal(result[0]!.success, true);
  assert.equal(result[1]!.error, 'forbidden');
  assert.deepEqual(
    calls.map((item) => item.method),
    ['businessInfo'],
  );
});
