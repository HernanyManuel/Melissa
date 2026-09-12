import { SecretResolver, validateSecretReference } from '../secrets/secret-resolver';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const MAX_RESPONSE_BYTES = 64 * 1024;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GoogleOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date;
  scopes: string[];
}

export class GoogleOAuthInvalidGrant extends Error {
  constructor() {
    super('Google OAuth grant is invalid');
    this.name = 'GoogleOAuthInvalidGrant';
  }
}

export class GoogleOAuthUnavailable extends Error {
  constructor() {
    super('Google OAuth is unavailable');
    this.name = 'GoogleOAuthUnavailable';
  }
}

export class GoogleOAuthTokenClient {
  constructor(
    private readonly secrets: SecretResolver,
    private readonly clientId: string,
    private readonly clientSecretReference: string,
    private readonly timeoutMs = 15000,
    private readonly fetcher: HttpFetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.text(clientId, 1, 512);
    validateSecretReference(clientSecretReference);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
      throw new Error('Invalid Google OAuth configuration');
  }

  async exchange(input: {
    code: string;
    redirectUri: string;
    pkceVerifier: string;
  }): Promise<GoogleOAuthTokens> {
    const code = this.text(input.code, 1, 4096);
    const redirectUri = this.redirect(input.redirectUri);
    if (!PKCE_VERIFIER.test(input.pkceVerifier)) throw new GoogleOAuthUnavailable();

    let clientSecret: string;
    try {
      clientSecret = this.text(
        await this.secrets.resolve(validateSecretReference(this.clientSecretReference)),
        16,
        4096,
      );
    } catch {
      throw new GoogleOAuthUnavailable();
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: clientSecret,
      code,
      code_verifier: input.pkceVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    let response: Response;
    try {
      response = await this.fetcher(TOKEN_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
    } catch {
      throw new GoogleOAuthUnavailable();
    }

    const payload = await this.readJson(response);
    if (!response.ok) {
      if (
        response.status === 400 &&
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        (payload as { error?: unknown }).error === 'invalid_grant'
      )
        throw new GoogleOAuthInvalidGrant();
      throw new GoogleOAuthUnavailable();
    }
    return this.tokens(payload);
  }

  private tokens(payload: unknown): GoogleOAuthTokens {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new GoogleOAuthUnavailable();
    const item = payload as Record<string, unknown>;
    if (item.token_type !== 'Bearer') throw new GoogleOAuthUnavailable();
    const accessToken = this.text(item.access_token, 16, 4096);
    const refreshToken =
      item.refresh_token === undefined ? null : this.text(item.refresh_token, 16, 4096);
    if (
      !Number.isInteger(item.expires_in) ||
      Number(item.expires_in) < 1 ||
      Number(item.expires_in) > 86400
    )
      throw new GoogleOAuthUnavailable();
    const scopes =
      item.scope === undefined
        ? []
        : this.text(item.scope, 1, 8192).split(' ').filter(Boolean);
    if (scopes.length > 64 || new Set(scopes).size !== scopes.length)
      throw new GoogleOAuthUnavailable();
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: new Date(this.now().getTime() + Number(item.expires_in) * 1000),
      scopes,
    };
  }

  private redirect(value: string): string {
    const raw = this.text(value, 8, 2048);
    try {
      const url = new URL(raw);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error('invalid redirect');
      return url.toString();
    } catch {
      throw new GoogleOAuthUnavailable();
    }
  }

  private text(value: unknown, minimum: number, maximum: number): string {
    if (
      typeof value !== 'string' ||
      value.length < minimum ||
      value.length > maximum ||
      value !== value.trim() ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      throw new GoogleOAuthUnavailable();
    return value;
  }

  private async readJson(response: Response): Promise<unknown> {
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))
      throw new GoogleOAuthUnavailable();
    if (!response.body) throw new GoogleOAuthUnavailable();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new GoogleOAuthUnavailable();
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode()) as unknown;
    } catch (error) {
      if (error instanceof GoogleOAuthUnavailable) throw error;
      throw new GoogleOAuthUnavailable();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
