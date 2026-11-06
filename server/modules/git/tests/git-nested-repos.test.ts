import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import spawn from 'cross-spawn';
import express from 'express';

import { createGitRouter } from '../git.routes.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

async function makeRepo(dir: string, branch: string) {
  await fs.mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  await fs.writeFile(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
}

async function startServer(projectPath: string) {
  const app = express();
  app.use(express.json());
  app.use('/api/git', createGitRouter({
    fileSystem: fs,
    spawnProcess: spawn,
    resolveProjectPathById: () => projectPath,
    queryClaude: (async () => undefined) as never,
    queryCursor: (async () => undefined) as never,
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}/api/git`, close: () => server.close() };
}

test('a task folder of repos lists each repo and git calls can target one', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nested-repos-'));
  await makeRepo(path.join(root, 'golfn-api'), 'feat/x');
  await makeRepo(path.join(root, 'golfn-app'), 'feat/y');
  await fs.writeFile(path.join(root, 'golfn-app', 'b.txt'), 'b\n');
  const server = await startServer(root);
  t.after(async () => {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const repos = (await (await fetch(`${server.base}/repos?project=p`)).json()) as any;
  assert.equal(repos.nested, true);
  assert.deepEqual(
    repos.repos.map((r: { path: string; branch: string; changes: number }) => [r.path, r.branch, r.changes]),
    [['golfn-api', 'feat/x', 0], ['golfn-app', 'feat/y', 1]],
  );

  const rootStatus = (await (await fetch(`${server.base}/status?project=p`)).json()) as any;
  assert.equal(rootStatus.notGitRepository, true);

  const appStatus = (await (await fetch(`${server.base}/status?project=p&repo=golfn-app`)).json()) as any;
  assert.equal(appStatus.branch, 'feat/y');
  assert.deepEqual(appStatus.untracked, ['b.txt']);

  const escape = (await (await fetch(`${server.base}/status?project=p&repo=../..`)).json()) as any;
  assert.equal(escape.branch, undefined);
  assert.ok(escape.error);
});

test('a project that is itself a repo is reported as a single, non-nested repo', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-repo-'));
  await makeRepo(root, 'main');
  const server = await startServer(root);
  t.after(async () => {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const repos = (await (await fetch(`${server.base}/repos?project=p`)).json()) as any;
  assert.equal(repos.nested, false);
  assert.equal(repos.repos.length, 1);
  assert.equal(repos.repos[0].path, '.');
  assert.equal(repos.repos[0].branch, 'main');
});
