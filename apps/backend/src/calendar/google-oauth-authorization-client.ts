import { CalendarOAuthStart } from './calendar-oauth-state.service';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const STATE = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export class GoogleOAuthAuthorizationClient {
  private readonly scopes: readonly string[];

  constructor(
    private readonly clientId: string,
    scopes: readonly string[],
  ) {
    this.text(clientId, 1, 512);
    if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 32)
      throw new Error('Invalid Google OAuth configuration');
    const normalized = scopes.map((scope) => this.text(scope, 1, 256));
    if (new Set(normalized).size !== normalized.length)
      throw new Error('Invalid Google OAuth configuration');
    this.scopes = [...normalized];
  }

  build(start: CalendarOAuthStart): string {
    if (!STATE.test(start.state) || !CHALLENGE.test(start.codeChallenge))
      throw new Error('Invalid Google OAuth authorization state');
    if (start.codeChallengeMethod !== 'S256')
      throw new Error('Invalid Google OAuth authorization state');
    const redirectUri = this.redirect(start.redirectUri);

    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      state: start.state,
      code_challenge: start.codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
    }).toString();
    return url.toString();
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
      throw new Error('Invalid Google OAuth authorization state');
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
      throw new Error('Invalid Google OAuth configuration');
    return value;
  }
}
