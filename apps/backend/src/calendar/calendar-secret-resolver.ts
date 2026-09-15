import { SecretResolver } from '../secrets/secret-resolver';

const DYNAMIC_PREFIX = 'secret://calendar-db/';

/** Routes server-owned calendar credential references without permissive fallback. */
export class CalendarSecretResolver implements SecretResolver {
  constructor(
    private readonly mounted: SecretResolver,
    private readonly dynamic: SecretResolver,
  ) {}

  resolve(reference: string): Promise<string> {
    return reference.startsWith(DYNAMIC_PREFIX)
      ? this.dynamic.resolve(reference)
      : this.mounted.resolve(reference);
  }
}
