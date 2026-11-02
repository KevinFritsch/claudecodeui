import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

import { appConfigDb } from '@/modules/database/index.js';
import { claudePlanUsageService } from '@/modules/providers/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * Starts Claude's 5-hour session window on a schedule.
 *
 * The window opens with the first request after the previous one ended, so a
 * 9 am start means a 2 pm reset. A tiny Sonnet ping at, say, 7 am Paris time
 * on weekdays moves the window to 7 am–12 pm, which leaves a second full
 * window for the afternoon. The ping goes through the local `claude` CLI so it
 * uses the machine's existing subscription login.
 */

export type SessionWarmupConfig = {
  enabled: boolean;
  /** ISO weekdays the ping runs on: 1 = Monday … 7 = Sunday. */
  days: number[];
  /** Local wall-clock time in `timeZone`, `HH:MM`. */
  time: string;
  /** IANA zone name, e.g. `Europe/Paris`. Daylight-saving shifts follow it. */
  timeZone: string;
  /** Model alias handed to `claude --model`; Sonnet keeps the ping cheap. */
  model: string;
};

export type SessionWarmupOutcome = 'started' | 'already-active' | 'failed';

export type SessionWarmupStatus = {
  lastRunAt: string | null;
  /** The local calendar day (in the configured zone) the last scheduled ping covered. */
  lastRunDay: string | null;
  lastOutcome: SessionWarmupOutcome | null;
  lastError: string | null;
  /** When the session window that exists after the last run ends, if known. */
  sessionResetsAt: string | null;
};

export type SessionWarmupState = {
  config: SessionWarmupConfig;
  status: SessionWarmupStatus;
  /** The next scheduled ping, or null when disabled or no day is selected. */
  nextRunAt: string | null;
};

/** Runs one prompt through the CLI. Injected in tests. */
export type WarmupPinger = (model: string) => Promise<void>;

const CONFIG_KEY = 'session_warmup_config';
const STATUS_KEY = 'session_warmup_status';
const POLL_INTERVAL_MS = 30_000;
// A ping later than this after its slot no longer lines the window up usefully
// (server was down overnight), so the day is skipped instead.
const CATCH_UP_WINDOW_MS = 90 * 60_000;
const PING_TIMEOUT_MS = 90_000;
const PING_PROMPT = 'Reply with the single word: ok';
const ALLOWED_MODELS = new Set(['sonnet', 'haiku']);

const DEFAULT_CONFIG: SessionWarmupConfig = {
  enabled: false,
  days: [1, 2, 3, 4, 5],
  time: '07:00',
  timeZone: 'Europe/Paris',
  model: 'sonnet',
};

const EMPTY_STATUS: SessionWarmupStatus = {
  lastRunAt: null,
  lastRunDay: null,
  lastOutcome: null,
  lastError: null,
  sessionResetsAt: null,
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let runInFlight = false;

// ----------------------------------------------------------------- time maths

const WEEKDAY_NUMBERS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

type ZonedParts = { day: string; isoWeekday: number; minutesOfDay: number };

/** The calendar day, weekday and minute-of-day that `instant` has on a wall clock in `timeZone`. */
function readZonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    day: `${pick('year')}-${pick('month')}-${pick('day')}`,
    isoWeekday: WEEKDAY_NUMBERS[pick('weekday')] ?? 1,
    minutesOfDay: Number(pick('hour')) * 60 + Number(pick('minute')),
  };
}

function parseTime(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 7 * 60;
}

/** The UTC instant at which a `YYYY-MM-DD` day in `timeZone` shows `minutesOfDay` on the wall clock. */
function zonedInstant(day: string, minutesOfDay: number, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  const naiveUtc = Date.UTC(year, month - 1, date, 0, minutesOfDay);
  // The zone's offset at that moment is found by reading the wall clock back,
  // then applied once; one correction is enough outside the DST gap itself.
  const shown = readZonedParts(new Date(naiveUtc), timeZone);
  const [shownYear, shownMonth, shownDate] = shown.day.split('-').map(Number);
  const shownUtc = Date.UTC(shownYear, shownMonth - 1, shownDate, 0, shown.minutesOfDay);
  return new Date(naiveUtc - (shownUtc - naiveUtc));
}

function addDays(day: string, amount: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + amount)).toISOString().slice(0, 10);
}

/** The next scheduled ping strictly after `now`, or null when nothing is scheduled. */
export function computeNextRun(config: SessionWarmupConfig, now: Date): Date | null {
  if (!config.enabled || config.days.length === 0) return null;
  const slot = parseTime(config.time);
  const today = readZonedParts(now, config.timeZone).day;
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = addDays(today, offset);
    const instant = zonedInstant(day, slot, config.timeZone);
    const weekday = readZonedParts(instant, config.timeZone).isoWeekday;
    if (instant.getTime() > now.getTime() && config.days.includes(weekday)) return instant;
  }
  return null;
}

/**
 * Whether today's ping is due: enabled, today is a chosen weekday, the slot
 * has passed (but not by more than the catch-up window), and it has not run
 * for today yet.
 */
export function isPingDue(config: SessionWarmupConfig, lastRunDay: string | null, now: Date): boolean {
  if (!config.enabled) return false;
  const today = readZonedParts(now, config.timeZone);
  if (!config.days.includes(today.isoWeekday) || lastRunDay === today.day) return false;
  const slotAt = zonedInstant(today.day, parseTime(config.time), config.timeZone).getTime();
  const lateBy = now.getTime() - slotAt;
  return lateBy >= 0 && lateBy <= CATCH_UP_WINDOW_MS;
}

// ------------------------------------------------------------------ settings

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Checks a settings payload from the client and returns it as a typed config; throws a 400 on bad input. */
export function parseConfigInput(input: unknown): SessionWarmupConfig {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const fail = (message: string): never => {
    throw new AppError(message, { code: 'INVALID_SESSION_WARMUP', statusCode: 400 });
  };

  if (typeof body.enabled !== 'boolean') fail('enabled must be true or false.');
  if (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) fail('time must look like 07:00.');
  if (typeof body.timeZone !== 'string' || !isValidTimeZone(body.timeZone)) fail('timeZone must be an IANA zone such as Europe/Paris.');
  if (typeof body.model !== 'string' || !ALLOWED_MODELS.has(body.model)) fail('model must be sonnet or haiku.');
  const days = body.days;
  if (!Array.isArray(days) || !days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) {
    fail('days must be weekday numbers from 1 (Monday) to 7 (Sunday).');
  }

  return {
    enabled: body.enabled as boolean,
    days: [...new Set(days as number[])].sort((a, b) => a - b),
    time: body.time as string,
    timeZone: body.timeZone as string,
    model: body.model as string,
  };
}

function readJson<T>(key: string, fallback: T): T {
  const raw = appConfigDb.get(key);
  if (!raw) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

function writeStatus(patch: Partial<SessionWarmupStatus>): SessionWarmupStatus {
  const next = { ...readJson(STATUS_KEY, EMPTY_STATUS), ...patch };
  appConfigDb.set(STATUS_KEY, JSON.stringify(next));
  return next;
}

/** Current settings, last-run status and the next scheduled ping, for the Usage dialog. */
export function getSessionWarmupState(now: Date = new Date()): SessionWarmupState {
  const config = readJson(CONFIG_KEY, DEFAULT_CONFIG);
  return {
    config,
    status: readJson(STATUS_KEY, EMPTY_STATUS),
    nextRunAt: computeNextRun(config, now)?.toISOString() ?? null,
  };
}

/** Saves new settings. A changed slot forgets today's run so moving the time later still fires today. */
export function saveSessionWarmupConfig(input: unknown): SessionWarmupState {
  const config = parseConfigInput(input);
  const previous = readJson(CONFIG_KEY, DEFAULT_CONFIG);
  appConfigDb.set(CONFIG_KEY, JSON.stringify(config));
  if (previous.time !== config.time || previous.timeZone !== config.timeZone) {
    writeStatus({ lastRunDay: null });
  }
  return getSessionWarmupState();
}

// ---------------------------------------------------------------------- ping

/** Sends one tiny prompt through the `claude` CLI: no settings, no slash commands, nothing persisted. */
export const claudeCliPinger: WarmupPinger = (model) => new Promise((resolve, reject) => {
  const child = spawn(
    'claude',
    ['-p', '--setting-sources', '', '--no-session-persistence', '--model', model, '--disable-slash-commands'],
    // A neutral cwd keeps project CLAUDE.md files and hooks out of the call.
    { cwd: tmpdir(), stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let stderr = '';
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error('the ping timed out'));
  }, PING_TIMEOUT_MS);
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-500);
  });
  child.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve();
    else reject(new Error(`claude exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
  });
  child.stdin.end(PING_PROMPT);
});

async function readSessionResetsAt(forceRefresh: boolean): Promise<string | null> {
  try {
    const usage = await claudePlanUsageService.getPlanUsage({ forceRefresh });
    const session = usage.limits.find((limit) => limit.kind === 'session');
    return session?.resetsAt && Date.parse(session.resetsAt) > Date.now() ? session.resetsAt : null;
  } catch {
    // Usage is only used to skip a redundant ping or to report; never block on it.
    return null;
  }
}

/**
 * Opens a session window now unless one is already running.
 *
 * Exported so the "Run now" button and tests can drive a ping without waiting
 * for the schedule. `scheduledDay` marks the day as handled for the timer.
 */
export async function runSessionWarmup(
  options: { scheduledDay?: string | null; pinger?: WarmupPinger } = {},
): Promise<SessionWarmupStatus> {
  const config = readJson(CONFIG_KEY, DEFAULT_CONFIG);
  const pinger = options.pinger ?? claudeCliPinger;
  const finish = (outcome: SessionWarmupOutcome, patch: Partial<SessionWarmupStatus>) =>
    writeStatus({
      lastRunAt: new Date().toISOString(),
      lastOutcome: outcome,
      ...(options.scheduledDay ? { lastRunDay: options.scheduledDay } : {}),
      ...patch,
    });

  const activeUntil = await readSessionResetsAt(true);
  if (activeUntil) {
    return finish('already-active', { lastError: null, sessionResetsAt: activeUntil });
  }

  try {
    await pinger(config.model);
  } catch (error) {
    return finish('failed', {
      lastError: error instanceof Error ? error.message : String(error),
      sessionResetsAt: null,
    });
  }
  return finish('started', { lastError: null, sessionResetsAt: await readSessionResetsAt(true) });
}

/** Manual run from the dialog; refuses to overlap a ping that is already in flight. */
export async function runSessionWarmupNow(): Promise<SessionWarmupState> {
  if (runInFlight) {
    throw new AppError('A warm-up ping is already running.', { code: 'SESSION_WARMUP_BUSY', statusCode: 409 });
  }
  runInFlight = true;
  try {
    await runSessionWarmup();
  } finally {
    runInFlight = false;
  }
  return getSessionWarmupState();
}

/** One timer pass: pings if today's slot is due. Exported for tests. */
export async function tickSessionWarmup(now: Date = new Date(), pinger?: WarmupPinger): Promise<boolean> {
  if (runInFlight) return false;
  const config = readJson(CONFIG_KEY, DEFAULT_CONFIG);
  const status = readJson(STATUS_KEY, EMPTY_STATUS);
  if (!isPingDue(config, status.lastRunDay, now)) return false;

  runInFlight = true;
  try {
    await runSessionWarmup({ scheduledDay: readZonedParts(now, config.timeZone).day, pinger });
  } finally {
    runInFlight = false;
  }
  return true;
}

/**
 * Starts the poll. The schedule and last-run day live in the database, so a
 * restart neither repeats a ping nor misses one that fell due while the
 * server was down (within the catch-up window).
 */
export function initializeSessionWarmup(): void {
  if (pollTimer) return;
  const poll = () => {
    void tickSessionWarmup().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[SessionWarmup] Pass failed', { error: message });
    });
  };
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll.
  pollTimer.unref?.();
  poll();
}

export function closeSessionWarmup(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
