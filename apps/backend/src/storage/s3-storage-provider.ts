import { createHash, createHmac } from 'node:crypto';
import {
  StorageMetadata,
  StoragePayloadConflict,
  StorageProvider,
  StorageWrite,
  StoredObject,
} from './storage-provider';

type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;
interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const KEY = /^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,255}$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[-a-z0-9.+]{1,64}$/;

export class S3StorageProvider implements StorageProvider {
  readonly providerKey = 's3';
  private readonly origin: string;

  constructor(
    endpoint: string,
    private readonly region: string,
    private readonly bucket: string,
    private readonly credentials: S3Credentials,
    private readonly maxObjectBytes = 10 * 1024 * 1024,
    private readonly timeoutMs = 15000,
    private readonly fetcher: HttpFetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (url.port && url.port !== '443') ||
      !/^[a-z0-9-]{1,64}$/.test(region) ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      credentials.accessKeyId.length < 8 ||
      credentials.secretAccessKey.length < 16 ||
      maxObjectBytes < 1 ||
      timeoutMs < 100 ||
      timeoutMs > 60000
    )
      throw new Error('Invalid S3 storage configuration');
    this.origin = url.origin;
  }

  async put(input: StorageWrite): Promise<StorageMetadata> {
    this.validate(input.key, input.contentType);
    if (!(input.body instanceof Uint8Array) || input.body.byteLength < 1)
      throw new Error('Invalid storage body');
    if (input.body.byteLength > this.maxObjectBytes) throw new Error('Storage object too large');
    const checksumSha256 = this.checksum(input.contentType, input.body);
    const response = await this.request(
      'PUT',
      input.key,
      {
        'content-type': input.contentType,
        'if-none-match': '*',
        'x-amz-meta-melissa-checksum': checksumSha256,
      },
      input.body,
    );
    if (response.status === 412 || response.status === 409) {
      const previous = await this.head(input.key);
      if (
        previous?.checksumSha256 !== checksumSha256 ||
        previous.contentType !== input.contentType ||
        previous.size !== input.body.byteLength
      )
        throw new StoragePayloadConflict();
      return previous;
    }
    if (!response.ok) throw new Error('Storage request failed');
    return {
      key: input.key,
      contentType: input.contentType,
      size: input.body.byteLength,
      checksumSha256,
      createdAt: this.now(),
    };
  }

  async get(key: string): Promise<StoredObject | null> {
    this.validateKey(key);
    const response = await this.request('GET', key, {}, new Uint8Array());
    if (response.status === 404) return null;
    if (!response.ok || !response.body) throw new Error('Storage request failed');
    const metadata = this.responseMetadata(key, response);
    if (metadata.size > this.maxObjectBytes) throw new Error('Storage object too large');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxObjectBytes) throw new Error('Storage object too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (size !== metadata.size) throw new Error('Storage size mismatch');
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (this.checksum(metadata.contentType, body) !== metadata.checksumSha256)
      throw new Error('Storage checksum mismatch');
    return { ...metadata, body };
  }

  async delete(key: string): Promise<boolean> {
    this.validateKey(key);
    if (!(await this.head(key))) return false;
    const response = await this.request('DELETE', key, {}, new Uint8Array());
    if (!response.ok) throw new Error('Storage request failed');
    return true;
  }

  private async head(key: string): Promise<StorageMetadata | null> {
    const response = await this.request('HEAD', key, {}, new Uint8Array());
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Storage request failed');
    return this.responseMetadata(key, response);
  }

  private responseMetadata(key: string, response: Response): StorageMetadata {
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
    const length = response.headers.get('content-length');
    const checksumSha256 = response.headers.get('x-amz-meta-melissa-checksum');
    const modified = response.headers.get('last-modified');
    if (
      !contentType ||
      !CONTENT_TYPE.test(contentType) ||
      !length ||
      !/^\d+$/.test(length) ||
      !Number.isSafeInteger(Number(length)) ||
      Number(length) < 1 ||
      !checksumSha256 ||
      !/^[a-f0-9]{64}$/.test(checksumSha256) ||
      !modified ||
      Number.isNaN(Date.parse(modified))
    )
      throw new Error('Invalid storage metadata');
    return {
      key,
      contentType,
      size: Number(length),
      checksumSha256,
      createdAt: new Date(modified),
    };
  }

  private async request(
    method: string,
    key: string,
    headers: Record<string, string>,
    body: Uint8Array,
  ): Promise<Response> {
    const path = `/${encodeURIComponent(this.bucket)}/${key
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/')}`;
    const signed = this.sign(method, path, headers, body);
    return this.fetcher(this.origin + path, {
      method,
      headers: signed,
      body: method === 'PUT' ? Buffer.from(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private sign(
    method: string,
    path: string,
    inputHeaders: Record<string, string>,
    body: Uint8Array,
  ): Record<string, string> {
    const instant = this.now()
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, '');
    const date = instant.slice(0, 8);
    const payloadHash = createHash('sha256').update(body).digest('hex');
    const headers: Record<string, string> = {
      ...inputHeaders,
      host: new URL(this.origin).host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': instant,
      ...(this.credentials.sessionToken
        ? { 'x-amz-security-token': this.credentials.sessionToken }
        : {}),
    };
    const names = Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort();
    const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim()}\n`).join('');
    const signedHeaders = names.join(';');
    const canonical = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const toSign = [
      'AWS4-HMAC-SHA256',
      instant,
      scope,
      createHash('sha256').update(canonical).digest('hex'),
    ].join('\n');
    const hmac = (key: Buffer | string, value: string) =>
      createHmac('sha256', key).update(value).digest();
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.credentials.secretAccessKey}`, date), this.region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return headers;
  }

  private checksum(contentType: string, body: Uint8Array): string {
    return createHash('sha256').update(contentType).update('\0').update(body).digest('hex');
  }

  private validate(key: string, contentType: string): void {
    this.validateKey(key);
    if (!CONTENT_TYPE.test(contentType)) throw new Error('Invalid storage content type');
  }

  private validateKey(key: string): void {
    if (!KEY.test(key) || key.split('/').some((part) => !part || part === '..'))
      throw new Error('Invalid storage key');
  }
}
