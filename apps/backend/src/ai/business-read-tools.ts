import { isUUID } from 'class-validator';
import { JsonObject } from './ai-provider';
import { BusinessToolReader } from './business-tool-reader';
import { ToolRegistration, ToolRegistry } from './tool-registry';

const EMPTY_SCHEMA: JsonObject = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function emptyArguments(value: JsonObject): JsonObject {
  if (Object.keys(value).length) throw new Error('Arguments must be empty');
  return {};
}

function serviceIdArguments(value: JsonObject): JsonObject {
  if (
    Object.keys(value).length !== 1 ||
    typeof value.serviceId !== 'string' ||
    !isUUID(value.serviceId)
  )
    throw new Error('Invalid service ID');
  return { serviceId: value.serviceId };
}

function dateArguments(value: JsonObject): JsonObject {
  if (
    Object.keys(value).length !== 1 ||
    typeof value.date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.date)
  )
    throw new Error('Invalid date');
  const parsed = new Date(`${value.date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value.date)
    throw new Error('Invalid date');
  return { date: value.date };
}

function serviceSchema(): JsonObject {
  return {
    type: 'object',
    properties: { serviceId: { type: 'string', format: 'uuid' } },
    required: ['serviceId'],
    additionalProperties: false,
  };
}

function readTool(
  name: string,
  description: string,
  inputSchema: JsonObject,
  capability: string,
  validateArguments: (value: JsonObject) => JsonObject,
  execute: ToolRegistration['execute'],
): ToolRegistration {
  return {
    definition: { name, description, inputSchema },
    effect: 'read',
    requiredCapabilities: [capability],
    supportsIdempotency: false,
    validateArguments,
    execute,
  };
}

export function registerBusinessReadTools(
  registry: ToolRegistry,
  reader: BusinessToolReader,
): void {
  registry.register(
    readTool(
      'get_business_info',
      'Get public information for the current business.',
      EMPTY_SCHEMA,
      'business.info.read',
      emptyArguments,
      (context) => reader.businessInfo(context.tenantId),
    ),
  );
  registry.register(
    readTool(
      'get_services',
      'List active services for the current business.',
      EMPTY_SCHEMA,
      'business.services.read',
      emptyArguments,
      (context) => reader.services(context.tenantId),
    ),
  );
  registry.register(
    readTool(
      'get_service_details',
      'Get details for one active service of the current business.',
      serviceSchema(),
      'business.services.read',
      serviceIdArguments,
      (context, arguments_) =>
        reader.serviceDetails(context.tenantId, arguments_.serviceId as string),
    ),
  );
  registry.register(
    readTool(
      'get_price',
      'Get the configured price and currency for one active service.',
      serviceSchema(),
      'business.services.read',
      serviceIdArguments,
      (context, arguments_) => reader.price(context.tenantId, arguments_.serviceId as string),
    ),
  );
  registry.register(
    readTool(
      'get_business_hours',
      'Get opening periods and exceptions for one local calendar date.',
      {
        type: 'object',
        properties: { date: { type: 'string', format: 'date' } },
        required: ['date'],
        additionalProperties: false,
      },
      'business.hours.read',
      dateArguments,
      (context, arguments_) => reader.hours(context.tenantId, arguments_.date as string),
    ),
  );
  registry.register(
    readTool(
      'get_staff',
      'List active public staff records for the current business.',
      EMPTY_SCHEMA,
      'business.staff.read',
      emptyArguments,
      (context) => reader.staff(context.tenantId),
    ),
  );
}
