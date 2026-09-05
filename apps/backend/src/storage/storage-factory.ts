import { Configuration } from '../config';
import { S3StorageProvider } from './s3-storage-provider';
import { StorageProvider } from './storage-provider';

/** Configuration boundary only; disabled means no storage and never a mock fallback. */
export function createStorageProvider(config: Configuration): StorageProvider | null {
  if (config.STORAGE_PROVIDER === 'disabled') return null;
  if (
    !config.S3_ENDPOINT ||
    !config.S3_REGION ||
    !config.S3_BUCKET ||
    !config.S3_ACCESS_KEY_ID ||
    !config.S3_SECRET_ACCESS_KEY
  )
    throw new Error('Invalid S3 storage configuration');
  return new S3StorageProvider(config.S3_ENDPOINT, config.S3_REGION, config.S3_BUCKET, {
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    ...(config.S3_SESSION_TOKEN ? { sessionToken: config.S3_SESSION_TOKEN } : {}),
  });
}
