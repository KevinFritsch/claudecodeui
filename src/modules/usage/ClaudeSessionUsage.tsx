import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { cn } from '@/shared/utils';

/** Claude's current-session (5-hour) limit, the one that runs out first. */
type SessionUsage = {
  percent: number;
  resetsAt: string | null;
};

const REFRESH_MS = 60_000;

/**
 * Polls Claude's current-session usage once a minute while the page is
 * visible. The server caches the upstream call for a minute too, so several
 * open tabs still cost one request to Anthropic.
 */
export function useClaudeSessionUsage(): SessionUsage | null {
  const [usage, setUsage] = useState<SessionUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.hidden) return;
      try {
        const response = await api.providers.claudePlanUsage(false);
        const payload = await response.json();
        const limits: Array<{ kind?: string; percent?: number; resetsAt?: string | null }> = payload?.data?.limits ?? [];
        const session = limits.find((limit) => limit.kind === 'session');
        if (!cancelled && response.ok && session && typeof session.percent === 'number') {
          setUsage({ percent: session.percent, resetsAt: session.resetsAt ?? null });
        }
      } catch {
        // Keep the last value; the next tick tries again.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return usage;
}

/** "2h 13m", "45m", or null when the reset time is unknown or past. */
export function formatSessionReset(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return null;
  const minutes = Math.max(0, Math.ceil((resetMs - now) / 60_000));
  if (minutes === 0) return null;
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

function percentTone(percent: number): string {
  if (percent >= 90) return 'text-red-500';
  if (percent >= 70) return 'text-amber-500';
  return 'text-muted-foreground';
}

type ClaudeSessionUsageBadgeProps = {
  usage: SessionUsage | null;
  /** `compact` shows the percentage only (collapsed sidebar). */
  compact?: boolean;
  className?: string;
};

/** Used by the sidebar footer next to "View Usage": current-session percentage and time until it resets. */
export function ClaudeSessionUsageBadge({ usage, compact = false, className }: ClaudeSessionUsageBadgeProps) {
  if (!usage) return null;
  const percent = Math.min(100, Math.max(0, Math.round(usage.percent)));
  const reset = formatSessionReset(usage.resetsAt);
  const title = `Claude current session: ${percent}% used${reset ? ` · resets in ${reset}` : ''}`;

  return (
    <span className={cn('flex items-center gap-1.5 text-[11px] tabular-nums', className)} title={title}>
      <span className={cn('font-medium', percentTone(percent))}>{percent}%</span>
      {!compact && reset && (
        <>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-muted-foreground">{reset}</span>
        </>
      )}
    </span>
  );
}
