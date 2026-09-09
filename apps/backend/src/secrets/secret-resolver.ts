export interface SecretResolver {
  resolve(reference: string): Promise<string>;
}

export class SecretUnavailable extends Error {
  constructor() {
    super('Secret is unavailable');
    this.name = 'SecretUnavailable';
  }
}

export function validateSecretReference(reference: string): string {
  if (
    reference.length < 1 ||
    reference.length > 512 ||
    reference !== reference.trim() ||
    /[\u0000-\u001f\u007f]/.test(reference)
  )
    throw new SecretUnavailable();
  return reference;
}
