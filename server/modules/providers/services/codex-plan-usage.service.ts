import { access, open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** One rate-limit window, shaped like the Claude plan usage limits so the UI renders both alike. */
type CodexPlanUsageLimit = {
  kind: string;
  label: string;
  percent: number;
  resetsAt: string | null;
};

type CodexPlanUsage = {
  /** False when Codex has no login on this machine; the UI then hides the Codex section. */
  connected: boolean;
  limits: CodexPlanUsageLimit[];
  planType: string | null;
  /** When Codex last reported these numbers (its most recent turn), or null when it never has. */
  reportedAt: string | null;
};

type AnyRecord = Record<string, unknown>;

// Only the tail of a rollout is read: the latest rate-limit report sits at
// the end, and rollouts of long sessions run to many megabytes.
const ROLLOUT_TAIL_BYTES = 512 * 1024;
// Day directories checked, newest first, before giving up on finding a rollout.
const MAX_DAY_DIRECTORIES = 14;

const codexHome = () => process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');

const readRecord = (value: unknown): AnyRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : null;

const readNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

async function listDescending(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  } catch {
    return [];
  }
}

/** Rollout files from the newest `sessions/YYYY/MM/DD` directories, newest first by modification time. */
async function findRecentRollouts(): Promise<string[]> {
  const sessionsRoot = path.join(codexHome(), 'sessions');
  const dayDirectories: string[] = [];
  for (const year of await listDescending(sessionsRoot)) {
    for (const month of await listDescending(path.join(sessionsRoot, year))) {
      for (const day of await listDescending(path.join(sessionsRoot, year, month))) {
        dayDirectories.push(path.join(sessionsRoot, year, month, day));
        if (dayDirectories.length >= MAX_DAY_DIRECTORIES) break;
      }
      if (dayDirectories.length >= MAX_DAY_DIRECTORIES) break;
    }
    if (dayDirectories.length >= MAX_DAY_DIRECTORIES) break;
  }

  const rollouts: Array<{ file: string; modifiedAt: number }> = [];
  for (const directory of dayDirectories) {
    let names: string[] = [];
    try {
      names = (await readdir(directory)).filter((name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(directory, name);
      try {
        rollouts.push({ file, modifiedAt: (await stat(file)).mtimeMs });
      } catch {
        // Deleted between listing and stat.
      }
    }
    // Directories are newest first, so once one holds rollouts the rest are older.
    if (rollouts.length > 0) break;
  }
  return rollouts.sort((a, b) => b.modifiedAt - a.modifiedAt).map((entry) => entry.file);
}

async function readTail(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function labelForWindow(windowMinutes: number | null, fallback: string): string {
  if (windowMinutes === 300) return '5-hour limit';
  if (windowMinutes === 10_080) return 'Weekly limit';
  if (windowMinutes && windowMinutes % 1440 === 0) return `${windowMinutes / 1440}-day limit`;
  if (windowMinutes && windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour limit`;
  return fallback;
}

function readWindow(window: unknown, kind: string, fallbackLabel: string, now: number): CodexPlanUsageLimit | null {
  const record = readRecord(window);
  const percent = readNumber(record?.used_percent);
  if (!record || percent === null) return null;
  const resetsAtSeconds = readNumber(record.resets_at);
  const resetsAtMs = resetsAtSeconds !== null ? resetsAtSeconds * 1000 : null;
  // A window that has rolled over since Codex last reported starts again from zero.
  const hasReset = resetsAtMs !== null && resetsAtMs <= now;
  return {
    kind,
    label: labelForWindow(readNumber(record.window_minutes), fallbackLabel),
    percent: hasReset ? 0 : percent,
    resetsAt: resetsAtMs !== null && !hasReset ? new Date(resetsAtMs).toISOString() : null,
  };
}

export const codexPlanUsageService = {
  /**
   * Returns the ChatGPT plan limits Codex last reported (5-hour and weekly),
   * read from the newest session rollout rather than the network, so the
   * Codex login token is never touched. Numbers are as fresh as Codex's
   * most recent turn.
   */
  async getPlanUsage(): Promise<CodexPlanUsage> {
    try {
      await access(path.join(codexHome(), 'auth.json'));
    } catch {
      return { connected: false, limits: [], planType: null, reportedAt: null };
    }

    const now = Date.now();
    for (const rollout of (await findRecentRollouts()).slice(0, 5)) {
      let tail: string;
      try {
        tail = await readTail(rollout);
      } catch {
        continue;
      }
      const lines = tail.split('\n');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index].includes('"rate_limits"')) continue;
        try {
          const event = readRecord(JSON.parse(lines[index]));
          const rateLimits = readRecord(readRecord(event?.payload)?.rate_limits);
          if (!rateLimits) continue;
          const limits = [
            readWindow(rateLimits.primary, 'primary', 'Short-term limit', now),
            readWindow(rateLimits.secondary, 'secondary', 'Long-term limit', now),
          ].filter((limit): limit is CodexPlanUsageLimit => limit !== null);
          return {
            connected: true,
            limits,
            planType: typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type : null,
            reportedAt: typeof event?.timestamp === 'string' ? event.timestamp : null,
          };
        } catch {
          // The first line of a tail is usually cut mid-record; skip it.
        }
      }
    }

    return { connected: true, limits: [], planType: null, reportedAt: null };
  },
};
