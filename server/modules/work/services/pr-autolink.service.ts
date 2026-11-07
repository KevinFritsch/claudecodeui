/**
 * Attaches a pull request to the chat session that created it.
 *
 * A session creates a PR with a POST to Bitbucket's /pullrequests API (the
 * golfn:bitbucket skill uses curl); that command names the source branch. We
 * scan session transcripts for such commands, incrementally (only bytes added
 * since the last scan), remember which branches each session opened PRs for,
 * and link every open PR whose repo/branch matches. Sessions that merely list
 * PRs (GET) never match.
 */

import fs from 'node:fs';

import { getConnection } from '@/modules/database/index.js';

import type { PullRequest } from './bitbucket.service.js';
import { linksService } from './links.service.js';

type Created = { repo: string | null; branch: string };

const scanned = new Map<string, { path: string; offset: number; created: Created[] }>();
const lastRun = new Map<string, number>();
const MIN_INTERVAL_MS = 60_000;
const LOOKBACK = '-7 days';

const REPO_RE = /repositories\/[^/\s"']+\/([a-z0-9._-]+)\/pullrequests/i;
const SOURCE_RE = /"source"\s*:\s*\{\s*"branch"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"/;

function commandsIn(chunk: string): Created[] {
  const found: Created[] = [];
  for (const line of chunk.split('\n')) {
    if (!line.includes('pullrequests') || !line.includes('tool_use') || !line.includes('POST')) continue;
    let entry: { message?: { content?: Array<{ type?: string; input?: unknown }> } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const block of entry.message?.content ?? []) {
      if (block.type !== 'tool_use') continue;
      const command = JSON.stringify(block.input ?? '').replace(/\\"/g, '"');
      if (!/POST/.test(command) || !/pullrequests/.test(command)) continue;
      const branch = command.match(SOURCE_RE)?.[1];
      if (branch) found.push({ repo: command.match(REPO_RE)?.[1] ?? null, branch });
    }
  }
  return found;
}

function scanSession(sessionId: string, jsonlPath: string): Created[] {
  let state = scanned.get(sessionId);
  if (!state || state.path !== jsonlPath) {
    state = { path: jsonlPath, offset: 0, created: [] };
    scanned.set(sessionId, state);
  }
  let size: number;
  try {
    size = fs.statSync(jsonlPath).size;
  } catch {
    return state.created;
  }
  if (size < state.offset) state.offset = 0;
  if (size === state.offset) return state.created;

  const fd = fs.openSync(jsonlPath, 'r');
  try {
    const buffer = Buffer.alloc(size - state.offset);
    fs.readSync(fd, buffer, 0, buffer.length, state.offset);
    const text = buffer.toString('utf8');
    // Only consume whole lines; a half-written last line is read next time.
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) return state.created;
    state.created.push(...commandsIn(text.slice(0, lastNewline)));
    state.offset += Buffer.byteLength(text.slice(0, lastNewline + 1));
  } finally {
    fs.closeSync(fd);
  }
  return state.created;
}

/** Links open PRs to the sessions that created them. Cheap to call often: throttled and incremental. */
export function autoLinkPullRequests(projectPath: string, pullRequests: PullRequest[]): void {
  const now = Date.now();
  if (now - (lastRun.get(projectPath) ?? 0) < MIN_INTERVAL_MS) return;
  lastRun.set(projectPath, now);
  if (pullRequests.length === 0) return;

  const sessions = getConnection()
    .prepare(
      `SELECT session_id, jsonl_path FROM sessions
       WHERE project_path = ? AND jsonl_path IS NOT NULL AND updated_at > datetime('now', ?)`,
    )
    .all(projectPath, LOOKBACK) as Array<{ session_id: string; jsonl_path: string }>;

  for (const session of sessions) {
    const created = scanSession(session.session_id, session.jsonl_path);
    if (created.length === 0) continue;
    for (const pr of pullRequests) {
      const match = created.some((c) => c.branch === pr.sourceBranch && (!c.repo || c.repo === pr.repo));
      if (match) linksService.add(projectPath, 'pr', `${pr.repo}#${pr.id}`, session.session_id);
    }
  }
}
