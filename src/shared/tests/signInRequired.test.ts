import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const respond = (status: number, headers: Record<string, string>) =>
  vi.fn(async () => new Response('{}', { status, headers }));

test('a 401 marked by the proxy asks to sign in again, once', async () => {
  vi.stubGlobal('fetch', respond(401, { 'X-Kvn-Sign-In': 'required' }));
  const { authenticatedFetch } = await import('@/shared/api');
  const { isSignInRequired, onSignInRequired } = await import('@/shared/signInRequired');

  let calls = 0;
  onSignInRequired(() => { calls += 1; });
  await authenticatedFetch('/api/projects');
  await authenticatedFetch('/api/projects');

  assert.equal(isSignInRequired(), true);
  assert.equal(calls, 1, 'the banner is told once, not per request');
});

test('other failures do not ask to sign in again', async () => {
  vi.stubGlobal('fetch', respond(401, {}));
  const { authenticatedFetch } = await import('@/shared/api');
  const { isSignInRequired } = await import('@/shared/signInRequired');
  await authenticatedFetch('/api/projects');
  assert.equal(isSignInRequired(), false);
});
