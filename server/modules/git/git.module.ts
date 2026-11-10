import * as fs from 'node:fs/promises';

import spawn from 'cross-spawn';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';

import { createGitRouter } from './git.routes.js';

type GitExternalDependencies = Pick<
  Parameters<typeof createGitRouter>[0],
  'queryClaude' | 'queryCursor'
>;

/** Assembles the Git router with runners from the centralized provider runtime service. */
export function createGitModule(externalDependencies: GitExternalDependencies) {
  return createGitRouter({
    fileSystem: fs,
    spawnProcess: spawn,
    resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
    // Kvn: app session ids differ from the provider's transcript id; the sessions table maps them.
    resolveSessionTranscript: (sessionId) =>
      (sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId))?.jsonl_path ?? null,
    ...externalDependencies,
  });
}
