/**
 * In-memory, stale-while-revalidate store of each project's remote Work data
 * (Jira, Bitbucket, Slack), kept in this Node process.
 *
 * - A request always answers from memory when there is anything there, and
 *   starts a background refresh when the data is older than STALE_MS.
 * - While someone has looked at a project in the last WARM_WHILE_VIEWED_MS,
 *   a timer keeps its data fresh, so opening the page shows current data at once.
 * - A source that fails keeps its previous items (with the error attached)
 *   instead of blanking the list.
 * - Actions (✅, reply, Jira move) patch the stored copy so a reload never
 *   brings back something just handled.
 */

import { listOpenPullRequests, type PullRequest } from './bitbucket.service.js';
import { listMyTasks, type JiraTask } from './jira.service.js';
import { listOpenMentions, type SlackMention } from './slack.service.js';
import { readAllProjectConfigs, readSecrets, type WorkProjectConfig } from './work-config.service.js';

export type SourceResult<T> = { items: T; error: string | null; fetchedAt: string };

export type RemoteSnapshot = {
  jira: SourceResult<JiraTask[]> | null;
  pullRequests: SourceResult<PullRequest[]> | null;
  slack: SourceResult<SlackMention[]> | null;
};

type Entry = {
  config: WorkProjectConfig;
  value: RemoteSnapshot | null;
  fetchedAt: number;
  inflight: Promise<RemoteSnapshot> | null;
  lastViewedAt: number;
};

const STALE_MS = 45_000;
const WARM_INTERVAL_MS = 2 * 60_000;
const WARM_WHILE_VIEWED_MS = 30 * 60_000;

const entries = new Map<string, Entry>();
let warmer: NodeJS.Timeout | null = null;

async function settle<T>(load: () => Promise<T>, previous: SourceResult<T> | null | undefined, fallback: T): Promise<SourceResult<T>> {
  const fetchedAt = new Date().toISOString();
  try {
    return { items: await load(), error: null, fetchedAt };
  } catch (error) {
    const message = (error as Error).message;
    console.warn('[work]', message);
    // Keep showing what we had; the error tells the UI it may be out of date.
    return previous
      ? { items: previous.items, error: message, fetchedAt: previous.fetchedAt }
      : { items: fallback, error: message, fetchedAt };
  }
}

function refresh(projectPath: string): Promise<RemoteSnapshot> {
  const entry = entries.get(projectPath);
  if (!entry) return Promise.reject(new Error('Unknown project.'));
  if (entry.inflight) return entry.inflight;

  const { config } = entry;
  const previous = entry.value;
  const secrets = readSecrets();
  entry.inflight = (async () => {
    const [jira, pullRequests, slack] = await Promise.all([
      config.jira ? settle(() => listMyTasks(secrets, config.jira!), previous?.jira, [] as JiraTask[]) : Promise.resolve(null),
      config.bitbucket
        ? settle(() => listOpenPullRequests(secrets, config.bitbucket!), previous?.pullRequests, [] as PullRequest[])
        : Promise.resolve(null),
      config.slack ? settle(() => listOpenMentions(secrets, config.slack!), previous?.slack, [] as SlackMention[]) : Promise.resolve(null),
    ]);
    const value = { jira, pullRequests, slack };
    entry.value = value;
    entry.fetchedAt = Date.now();
    return value;
  })().finally(() => {
    entry.inflight = null;
  });
  return entry.inflight;
}

function ensureWarmer(): void {
  if (warmer) return;
  warmer = setInterval(() => {
    const now = Date.now();
    for (const [projectPath, entry] of entries) {
      if (now - entry.lastViewedAt > WARM_WHILE_VIEWED_MS) continue;
      if (entry.inflight || now - entry.fetchedAt < STALE_MS) continue;
      void refresh(projectPath).catch(() => undefined);
    }
  }, WARM_INTERVAL_MS);
  warmer.unref();
}

/**
 * The project's remote data. Answers from memory when it can (refreshing in
 * the background if stale); waits only on the very first load or when `force`.
 */
export async function getSnapshot(
  projectPath: string,
  config: WorkProjectConfig,
  options: { force?: boolean } = {},
): Promise<{ snapshot: RemoteSnapshot; fetchedAt: string; refreshing: boolean }> {
  ensureWarmer();
  let entry = entries.get(projectPath);
  if (!entry) {
    entry = { config, value: null, fetchedAt: 0, inflight: null, lastViewedAt: Date.now() };
    entries.set(projectPath, entry);
  }
  entry.config = config;
  entry.lastViewedAt = Date.now();

  if (!entry.value || options.force) {
    await refresh(projectPath);
  } else if (Date.now() - entry.fetchedAt > STALE_MS) {
    void refresh(projectPath).catch(() => undefined);
  }

  return {
    snapshot: entry.value!,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    refreshing: Boolean(entry.inflight),
  };
}

/** Applies a local change to the stored copy, e.g. drop a Slack message just ✅'d. */
export function patchSnapshot(projectPath: string, patch: (snapshot: RemoteSnapshot) => void): void {
  const value = entries.get(projectPath)?.value;
  if (value) patch(value);
}

/** Marks the stored copy out of date so the next request refreshes it in the background. */
export function markStale(projectPath: string): void {
  const entry = entries.get(projectPath);
  if (entry) entry.fetchedAt = 0;
}

/**
 * Loads every configured project once, shortly after the server starts, so the
 * first visit after a restart is already instant.
 */
export function warmAllProjects(delayMs = 5_000): void {
  const timer = setTimeout(() => {
    for (const [projectPath, config] of Object.entries(readAllProjectConfigs())) {
      if (entries.has(projectPath)) continue;
      // Not counted as a view: the warmer only keeps projects fresh after someone opens them.
      entries.set(projectPath, { config, value: null, fetchedAt: 0, inflight: null, lastViewedAt: 0 });
      void refresh(projectPath).catch(() => undefined);
    }
  }, delayMs);
  timer.unref();
}
