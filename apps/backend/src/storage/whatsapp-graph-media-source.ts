import { MediaDownload, MediaSourceProvider, MediaUnavailable } from './media-source-provider';

type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

interface GraphMetadata {
  url: string;
  mime_type: string;
  file_size: number;
  sha256?: string;
}

const MEDIA_ID = /^[a-zA-Z0-9_-]{1,256}$/;
const VERSION = /^v[1-9][0-9]*\.[0-9]+$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Disabled-by-default Meta transport. It accepts no arbitrary metadata/download host. */
export class WhatsAppGraphMediaSource implements MediaSourceProvider {
  readonly providerKey = 'whatsapp';
  private readonly hosts: ReadonlySet<string>;

  constructor(
    private readonly accessToken: string,
    private readonly apiVersion: string,
    allowedDownloadHosts: readonly string[],
    private readonly maxBytes = 10 * 1024 * 1024,
    private readonly timeoutMs = 15000,
    private readonly fetcher: HttpFetch = fetch,
  ) {
    if (
      accessToken.trim().length < 16 ||
      accessToken !== accessToken.trim() ||
      accessToken.length > 4096 ||
      !VERSION.test(apiVersion) ||
      maxBytes < 1 ||
      timeoutMs < 100 ||
      timeoutMs > 60000
    )
      throw new Error('Invalid WhatsApp media transport configuration');
    const normalized = allowedDownloadHosts.map((host) => host.toLowerCase());
    if (!normalized.length || normalized.some((host) => !HOST.test(host)))
      throw new Error('Invalid WhatsApp media host allowlist');
    this.hosts = new Set(normalized);
  }

  async download(mediaId: string): Promise<MediaDownload> {
    if (!MEDIA_ID.test(mediaId)) throw new Error('Invalid media ID');
    try {
      const metadataResponse = await this.request(
        `https://graph.facebook.com/${this.apiVersion}/${encodeURIComponent(mediaId)}`,
        'application/json',
      );
      const metadataBytes = await this.readBounded(metadataResponse, 65536);
      const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as GraphMetadata;
      if (
        !metadata ||
        typeof metadata.url !== 'string' ||
        typeof metadata.mime_type !== 'string' ||
        !Number.isSafeInteger(metadata.file_size) ||
        metadata.file_size < 1 ||
        metadata.file_size > this.maxBytes ||
        (metadata.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(metadata.sha256))
      )
        throw new Error('Invalid metadata');
      const target = new URL(metadata.url);
      if (
        target.protocol !== 'https:' ||
        target.username ||
        target.password ||
        target.hash ||
        (target.port && target.port !== '443') ||
        !this.hosts.has(target.hostname.toLowerCase())
      )
        throw new Error('Blocked media host');
      const mediaResponse = await this.request(target.href, metadata.mime_type);
      const receivedType = mediaResponse.headers.get('content-type')?.split(';', 1)[0]?.trim();
      if (receivedType !== metadata.mime_type) throw new Error('Media content type mismatch');
      const body = await this.readBounded(mediaResponse, this.maxBytes);
      if (body.byteLength !== metadata.file_size) throw new Error('Media size mismatch');
      return { contentType: metadata.mime_type, body, checksumSha256: metadata.sha256 };
    } catch {
      // Provider details, URL and token must never escape into user/log errors.
      throw new MediaUnavailable();
    }
  }

  private async request(url: string, accept: string): Promise<Response> {
    const response = await this.fetcher(url, {
      method: 'GET',
      headers: { accept, authorization: `Bearer ${this.accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error('Provider request failed');
    return response;
  }

  private async readBounded(response: Response, limit: number): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
      throw new Error('Provider body too large');
    if (!response.body) throw new Error('Missing provider body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('Provider body too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}
