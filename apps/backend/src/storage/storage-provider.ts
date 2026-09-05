export interface StorageWrite {
  key: string;
  contentType: string;
  body: Uint8Array;
}

export interface StorageMetadata {
  key: string;
  contentType: string;
  size: number;
  checksumSha256: string;
  createdAt: Date;
}

export interface StoredObject extends StorageMetadata {
  body: Uint8Array;
}

export interface StorageProvider {
  readonly providerKey: string;
  put(input: StorageWrite): Promise<StorageMetadata>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<boolean>;
}

export class StoragePayloadConflict extends Error {
  constructor() {
    super('Storage key already contains different data');
    this.name = 'StoragePayloadConflict';
  }
}

export class StorageCapacityExceeded extends Error {
  constructor() {
    super('Storage capacity exceeded');
    this.name = 'StorageCapacityExceeded';
  }
}
