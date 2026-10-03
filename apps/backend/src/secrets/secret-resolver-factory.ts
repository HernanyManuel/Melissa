import { Configuration } from '../config';
import { MountedFileSecretResolver } from './mounted-file-secret-resolver';
import { SecretResolver } from './secret-resolver';

/** Disabled means no secret access and never a fallback to process environment values. */
export async function createSecretResolver(config: Configuration): Promise<SecretResolver | null> {
  if (config.SECRET_PROVIDER === 'disabled') return null;
  if (!config.SECRET_MOUNT_DIRECTORY) throw new Error('Invalid mounted secret configuration');
  return MountedFileSecretResolver.create(config.SECRET_MOUNT_DIRECTORY);
}
