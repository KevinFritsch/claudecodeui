import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { api } from '@/shared/api';
import { cn } from '@/shared/utils';

type WarmupConfig = {
  enabled: boolean;
  days: number[];
  time: string;
  timeZone: string;
  model: string;
};

type WarmupState = {
  config: WarmupConfig;
  status: {
    lastRunAt: string | null;
    lastOutcome: 'started' | 'already-active' | 'failed' | null;
    lastError: string | null;
    sessionResetsAt: string | null;
  };
  nextRunAt: string | null;
};

type SessionWarmupSettingsProps = {
  isOpen: boolean;
  /** Called after a manual ping opened a window, so the usage bars can refresh. */
  onSessionStarted: () => void;
};

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
];

const TIME_ZONES = ['Europe/Paris', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC'];

function formatInZone(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString(undefined, {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function describeLastRun(status: WarmupState['status'], timeZone: string): string | null {
  if (!status.lastRunAt || !status.lastOutcome) return null;
  const when = formatInZone(status.lastRunAt, timeZone);
  if (status.lastOutcome === 'failed') return `Last ping failed (${when}): ${status.lastError ?? 'unknown error'}`;
  if (status.lastOutcome === 'already-active') return `Last check ${when}: a session was already running, no ping sent.`;
  return status.sessionResetsAt
    ? `Last ping ${when}. Window ends ${formatInZone(status.sessionResetsAt, timeZone)}.`
    : `Last ping ${when}.`;
}

/** Used by the Usage dialog to schedule a tiny ping that opens the 5-hour Claude session window early. */
export function SessionWarmupSettings({ isOpen, onSessionStarted }: SessionWarmupSettingsProps) {
  // Server copy of the settings and last-run status; null until loaded.
  const [state, setState] = useState<WarmupState | null>(null);
  // Edited copy; saved on every change so there is no separate Save button.
  const [draft, setDraft] = useState<WarmupConfig | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((next: WarmupState) => {
    setState(next);
    setDraft(next.config);
    setError(null);
  }, []);

  const request = useCallback(async (call: () => Promise<Response>) => {
    setIsBusy(true);
    try {
      const response = await call();
      const payload = await response.json();
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
      }
      apply(payload.data as WarmupState);
      return payload.data as WarmupState;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
      return null;
    } finally {
      setIsBusy(false);
    }
  }, [apply]);

  useEffect(() => {
    if (isOpen) void request(() => api.sessionWarmup.get());
  }, [isOpen, request]);

  if (!state || !draft) {
    return error ? <p className="mt-4 text-xs text-red-600 dark:text-red-400">{error}</p> : null;
  }

  const save = (patch: Partial<WarmupConfig>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    void request(() => api.sessionWarmup.save(next));
  };

  const toggleDay = (day: number) =>
    save({ days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day] });

  const zones = TIME_ZONES.includes(draft.timeZone) ? TIME_ZONES : [draft.timeZone, ...TIME_ZONES];
  const lastRun = describeLastRun(state.status, draft.timeZone);

  return (
    <div className="mt-4 space-y-3 border-t border-border/60 pt-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">Session warm-up</h3>
        <button
          type="button"
          role="switch"
          aria-checked={draft.enabled}
          aria-label="Enable session warm-up"
          disabled={isBusy}
          onClick={() => save({ enabled: !draft.enabled })}
          className={cn(
            'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50',
            draft.enabled ? 'bg-primary' : 'bg-muted',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-4 w-4 rounded-full bg-background shadow transition-all',
              draft.enabled ? 'left-[1.125rem]' : 'left-0.5',
            )}
          />
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Sends a tiny {draft.model === 'haiku' ? 'Haiku' : 'Sonnet'} message at the chosen time so the 5-hour window starts
        before you do and resets earlier in your day.
      </p>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
        {WEEKDAYS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            disabled={isBusy}
            aria-pressed={draft.days.includes(value)}
            onClick={() => toggleDay(value)}
            className={cn(
              'rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-50',
              draft.days.includes(value)
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:bg-accent',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="time"
          value={draft.time}
          disabled={isBusy}
          aria-label="Ping time"
          onChange={(event) => event.target.value && save({ time: event.target.value })}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        />
        <select
          value={draft.timeZone}
          disabled={isBusy}
          aria-label="Time zone"
          onChange={(event) => save({ timeZone: event.target.value })}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        >
          {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
        </select>
        <select
          value={draft.model}
          disabled={isBusy}
          aria-label="Model"
          onChange={(event) => save({ model: event.target.value })}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
        </select>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {draft.enabled && state.nextRunAt
            ? `Next ping ${formatInZone(state.nextRunAt, draft.timeZone)} (${draft.timeZone})`
            : 'Off'}
        </p>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void request(() => api.sessionWarmup.runNow()).then((next) => next && onSessionStarted())}
          className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          {isBusy && <Loader2 className="h-3 w-3 animate-spin" />}
          Ping now
        </button>
      </div>

      {lastRun && <p className="text-[11px] text-muted-foreground/70">{lastRun}</p>}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
