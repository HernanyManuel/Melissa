import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { CalendarOAuthStateService } from '../src/calendar/calendar-oauth-state.service';
import { GoogleCalendarOAuthController } from '../src/calendar/google-calendar-oauth.controller';
import { GoogleCalendarOAuthFlow } from '../src/calendar/google-calendar-oauth-flow';
import { GoogleCalendarOAuthService } from '../src/calendar/google-calendar-oauth.service';
import { GoogleOAuthAuthorizationClient } from '../src/calendar/google-oauth-authorization-client';
import { AuthRequest } from '../src/identity/auth.guard';

const actor = {
  userId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
};
const tenantId = '33333333-3333-4333-8333-333333333333';
const callbackUri = 'https://api.example.test/api/v1/calendar/google/oauth/callback';
const start = {
  state: 's'.repeat(43),
  codeChallenge: 'c'.repeat(43),
  codeChallengeMethod: 'S256' as const,
  redirectUri: callbackUri,
  expiresAt: '2030-01-01T00:10:00.000Z',
};

test('Google Calendar OAuth start uses only the configured server callback', async () => {
  let seenActor: unknown;
  let seenTenant = '';
  let seenRedirect = '';
  const states = {
    begin: async (inputActor: unknown, inputTenant: string, redirectUri: string) => {
      seenActor = inputActor;
      seenTenant = inputTenant;
      seenRedirect = redirectUri;
      return start;
    },
  } as unknown as CalendarOAuthStateService;
  const authorization = {
    build: (input: unknown) => {
      assert.equal(input, start);
      return 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic';
    },
  } as unknown as GoogleOAuthAuthorizationClient;
  const flow = new GoogleCalendarOAuthFlow(
    states,
    authorization,
    {} as GoogleCalendarOAuthService,
    callbackUri,
  );

  assert.deepEqual(await flow.begin(actor, tenantId), {
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic',
    expiresAt: start.expiresAt,
  });
  assert.equal(seenActor, actor);
  assert.equal(seenTenant, tenantId);
  assert.equal(seenRedirect, callbackUri);
});

test('Google Calendar OAuth rejection consumes state and returns only a generic failure', async () => {
  const consumed: string[] = [];
  const states = {
    consume: async (state: string) => {
      consumed.push(state);
      return {};
    },
  } as unknown as CalendarOAuthStateService;
  const flow = new GoogleCalendarOAuthFlow(
    states,
    {} as GoogleOAuthAuthorizationClient,
    {} as GoogleCalendarOAuthService,
    callbackUri,
  );

  await assert.rejects(
    () => flow.reject('s'.repeat(43)),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === 'Google OAuth authorization failed' &&
      !error.message.includes('access_token') &&
      !error.message.includes('client_secret'),
  );
  assert.deepEqual(consumed, ['s'.repeat(43)]);
});

test('Google Calendar OAuth controller keeps callback authority in state', async () => {
  const completed: Array<{ state: string; code: string }> = [];
  const rejected: string[] = [];
  const flow = {
    begin: async () => ({ authorizationUrl: 'https://accounts.google.com/', expiresAt: 'later' }),
    complete: async (state: string, code: string) => {
      completed.push({ state, code });
      return { connectionId: tenantId, calendarRef: 'primary', status: 'connected' };
    },
    reject: async (state: string) => {
      rejected.push(state);
      throw new BadRequestException('Google OAuth authorization failed');
    },
  } as unknown as GoogleCalendarOAuthFlow;
  const controller = new GoogleCalendarOAuthController(flow);
  const req = { actor } as AuthRequest;

  await controller.start(req, tenantId);
  const result = await controller.callback('s'.repeat(43), 'authorization-code');
  assert.deepEqual(result, {
    connectionId: tenantId,
    calendarRef: 'primary',
    status: 'connected',
  });
  assert.deepEqual(completed, [{ state: 's'.repeat(43), code: 'authorization-code' }]);

  await assert.rejects(
    () => controller.callback('x'.repeat(43), undefined, 'access_denied'),
    BadRequestException,
  );
  assert.deepEqual(rejected, ['x'.repeat(43)]);
  assert.throws(() => controller.callback(undefined, 'authorization-code'), BadRequestException);
});
