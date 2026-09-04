import { MediaDownload, MediaSourceProvider, MediaUnavailable } from './media-source-provider';

/** Explicit test fixture provider. It never performs network access. */
export class MockMediaSourceProvider implements MediaSourceProvider {
  readonly providerKey = 'mock';
  private readonly fixtures = new Map<string, MediaDownload>();

  constructor(fixtures: Record<string, MediaDownload> = {}) {
    for (const [id, fixture] of Object.entries(fixtures))
      this.fixtures.set(id, { ...fixture, body: Uint8Array.from(fixture.body) });
  }

  async download(mediaId: string): Promise<MediaDownload> {
    const fixture = this.fixtures.get(mediaId);
    if (!fixture) throw new MediaUnavailable();
    return { ...fixture, body: Uint8Array.from(fixture.body) };
  }
}
