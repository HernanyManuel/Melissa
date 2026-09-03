import assert from 'node:assert/strict';
import { OpenAPIObject } from '@nestjs/swagger';
import {
  SchemaObject,
  ReferenceObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

export function assertQuarantineOpenApi(document: OpenAPIObject) {
  const operation = document.paths['/api/v1/tenants/{tenantId}/quarantine']?.get;
  assert(operation);
  assert.equal(operation.operationId, 'listQuarantineMetadata');
  assert.deepEqual(operation.security, [{ bearer: [] }]);
  for (const status of ['200', '400', '401', '403', '404', '500'])
    assert(operation.responses[status]);
  const parameters = operation.parameters?.filter((p) => !('$ref' in p)) ?? [];
  assert.equal(parameters.length, 2);
  assert(
    parameters.some(
      (p) => !('$ref' in p) && p.name === 'tenantId' && p.in === 'path' && p.required,
    ),
  );
  assert(
    parameters.some((p) => !('$ref' in p) && p.name === 'after' && p.in === 'query' && !p.required),
  );
  const page = document.components?.schemas?.QuarantinePageResponseDto;
  assert(page && !('$ref' in page));
  assert.deepEqual(
    Object.keys(page.properties ?? {}).sort(),
    ['items', 'next', 'total', 'expired', 'expiringSoon', 'capacity', 'notices', 'asOf'].sort(),
  );
  assert.deepEqual([...(page.required ?? [])].sort(), Object.keys(page.properties ?? {}).sort());
  const next = page.properties?.next;
  assert(next && !('$ref' in next));
  assert.equal(next.nullable, true);
  assert.equal(next.format, 'uuid');
  const items = page.properties?.items;
  assert(items && !('$ref' in items));
  assert.equal(items.maxItems, 50);
  assert.deepEqual(items.items, { $ref: '#/components/schemas/QuarantineMetadataDto' });
  const metadata = document.components?.schemas?.QuarantineMetadataDto;
  assert(metadata && !('$ref' in metadata));
  assert.deepEqual(
    Object.keys(metadata.properties ?? {}).sort(),
    ['id', 'channelId', 'channelName', 'createdAt', 'expiresAt', 'expired'].sort(),
  );
  for (const field of ['createdAt', 'expiresAt']) {
    const property: SchemaObject | ReferenceObject | undefined = metadata.properties?.[field];
    assert(property && !('$ref' in property));
    assert.equal(property.format, 'date-time');
    assert.equal(property.type, 'string');
  }
}
