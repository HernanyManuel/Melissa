export interface MediaDownload {
  contentType: string;
  body: Uint8Array;
  checksumSha256?: string;
}

/** Resolves an opaque provider media ID. Implementations must enforce their own network policy. */
export interface MediaSourceProvider {
  readonly providerKey: string;
  download(mediaId: string): Promise<MediaDownload>;
}

export class MediaUnavailable extends Error {
  constructor() {
    super('Media unavailable');
    this.name = 'MediaUnavailable';
  }
}
