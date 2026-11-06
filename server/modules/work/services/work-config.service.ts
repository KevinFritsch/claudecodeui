/**
 * Per-project configuration and secrets for the Work dashboard.
 *
 * Both live outside the repo under ~/.config/kvn-work/ (override with
 * KVN_WORK_CONFIG_DIR):
 * - projects.json: which providers each project path turns on, and their options.
 * - secrets.env:   API tokens (chmod 600). Read here on demand and never put into
 *   process.env, because every Claude session is a child of this server and
 *   would inherit them.
 *
 * Both files are re-read whenever their mtime changes, so edits apply without
 * a restart.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export type JiraProjectConfig = {
  projectKey: string;
  /** Statuses listed on the dashboard, in display order. */
  statuses: string[];
  /** Statuses rendered as a collapsed group (waiting on someone else). */
  collapsedStatuses?: string[];
  /** Transition targets offered as buttons, by status name. */
  actions: string[];
  /** Custom field holding the issue's sprints (Jira Software default: customfield_10020). */
  sprintField?: string;
};

export type BitbucketProjectConfig = {
  workspace: string;
  repos: string[];
};

export type WorkProjectConfig = {
  name?: string;
  jira?: JiraProjectConfig;
  bitbucket?: BitbucketProjectConfig;
  todos?: boolean;
};

export type WorkSecrets = Record<string, string>;

function configDir(): string {
  return process.env.KVN_WORK_CONFIG_DIR || path.join(os.homedir(), '.config', 'kvn-work');
}

type Cached<T> = { mtimeMs: number; value: T };
const cache = new Map<string, Cached<unknown>>();

function readCached<T>(file: string, parse: (raw: string) => T, fallback: T): T {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return fallback;
  }
  const hit = cache.get(file) as Cached<T> | undefined;
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.value;
  try {
    const value = parse(fs.readFileSync(file, 'utf8'));
    cache.set(file, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch (error) {
    console.warn(`[work] could not read ${file}:`, (error as Error).message);
    return fallback;
  }
}

function parseEnv(raw: string): WorkSecrets {
  const out: WorkSecrets = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

export function readSecrets(): WorkSecrets {
  return readCached(path.join(configDir(), 'secrets.env'), parseEnv, {});
}

export function readAllProjectConfigs(): Record<string, WorkProjectConfig> {
  return readCached(
    path.join(configDir(), 'projects.json'),
    (raw) => JSON.parse(raw) as Record<string, WorkProjectConfig>,
    {},
  );
}

function normalizePath(p: string): string {
  return path.resolve(p).replace(/\/+$/, '');
}

/** The Work config for a project path, or null when the project has none. */
export function getProjectConfig(projectPath: string): WorkProjectConfig | null {
  if (!projectPath) return null;
  const wanted = normalizePath(projectPath);
  const all = readAllProjectConfigs();
  for (const [key, value] of Object.entries(all)) {
    if (normalizePath(key) === wanted) return value;
  }
  return null;
}
