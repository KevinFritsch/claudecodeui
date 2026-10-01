import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    externalAuth: { enabled: false, logoutUrl: null },
    users: {
      hasUsers: () => false,
      getFirstUser: () => undefined,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      getFirstUser: () => undefined,
      createUser: (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(operations, ['begin', 'hash:secret12', 'create:alice:hash', 'commit', 'login:1']);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      getFirstUser: () => undefined,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});

test('external session is unavailable unless a login proxy is configured', () => {
  const service = createAuthService(createDependencies());
  assert.throws(() => service.createExternalSession(), (error: unknown) => error instanceof AppError && error.statusCode === 404);
  assert.equal(service.getStatus().externalAuth, false);
});

test('with a login proxy, the status skips setup and a session is issued for the first user', () => {
  const service = createAuthService(createDependencies({
    externalAuth: { enabled: true, logoutUrl: 'https://auth.example.com/logout' },
    users: {
      hasUsers: () => true,
      getFirstUser: () => ({ id: 7, username: 'kvn' }),
      createUser: () => ({ id: 1, username: 'x' }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
    },
  }));
  assert.deepEqual(service.getStatus(), {
    needsSetup: false,
    isAuthenticated: false,
    externalAuth: true,
    logoutUrl: 'https://auth.example.com/logout',
  });
  assert.deepEqual(service.createExternalSession(), {
    success: true,
    user: { id: 7, username: 'kvn' },
    token: 'signed-token',
  });
});
