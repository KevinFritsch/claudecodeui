import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

import { api } from '@/shared/api';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { cn } from '@/shared/utils';

type PlanUsageLimit = {
  kind: string;
  group: string | null;
  label: string;
  percent: number;
  resetsAt: string | null;
  severity: string | null;
  isActive: boolean;
};

type PlanUsage = {
  limits: PlanUsageLimit[];
  extraUsage: {
    enabled: boolean;
    usedMinor: number;
    limitMinor: number | null;
    currency: string;
    exponent: number;
  } | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  fetchedAt: string;
};

type CodexUsage = {
  connected: boolean;
  limits: Array<{ kind: string; label: string; percent: number; resetsAt: string | null }>;
  planType: string | null;
  reportedAt: string | null;
};

type UsageModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

function formatResetTime(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return null;

  const diffMinutes = Math.max(0, Math.round((resetMs - now) / 60_000));
  // Within a day a countdown reads better than a clock time.
  if (diffMinutes < 60) return `Resets in ${diffMinutes} min`;
  if (diffMinutes < 24 * 60) {
    const hours = Math.floor(diffMinutes / 60);
    const minutes = diffMinutes % 60;
    return `Resets in ${hours} h ${minutes} min`;
  }
  const resetLabel = new Date(resetMs).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Resets ${resetLabel}`;
}

function formatMoney(amountMinor: number, currency: string, exponent: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
    amountMinor / 10 ** exponent,
  );
}

function formatPlanName(usage: PlanUsage): string | null {
  const tierMatch = usage.rateLimitTier?.match(/max_(\d+)x/);
  const parts = [
    usage.subscriptionType ? usage.subscriptionType[0].toUpperCase() + usage.subscriptionType.slice(1) : null,
    tierMatch ? `Max ${tierMatch[1]}x` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function barColor(percent: number): string {
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 70) return 'bg-amber-500';
  return 'bg-primary';
}

/** Progress bars for a provider's rate-limit windows, with each window's reset time. */
function LimitBars({
  limits,
  now,
}: {
  limits: Array<{ kind: string; label: string; percent: number; resetsAt: string | null }>;
  now: number;
}) {
  return (
    <>
      {limits.map((limit) => {
        const percent = Math.min(100, Math.max(0, Math.round(limit.percent)));
        const resetLabel = formatResetTime(limit.resetsAt, now);
        return (
          <div key={`${limit.kind}:${limit.label}`}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-foreground">{limit.label}</span>
              <span className="text-sm tabular-nums text-muted-foreground">{percent}% used</span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={limit.label}
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className={cn('h-full rounded-full transition-all', barColor(percent))} style={{ width: `${percent}%` }} />
            </div>
            {resetLabel && <p className="mt-1 text-xs text-muted-foreground">{resetLabel}</p>}
          </div>
        );
      })}
    </>
  );
}

function SectionHeading({ title, subtitle }: { title: string; subtitle: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
    </div>
  );
}

// Time only for today; older reports (Codex idle for days) also need the date.
const formatClock = (iso: string) => {
  const date = new Date(iso);
  const isToday = date.toDateString() === new Date().toDateString();
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/** Used by the sidebar module's footer to show plan usage: Claude's session/weekly/per-model limits and, when Codex is logged in, its 5-hour and weekly limits. */
export function UsageModal({ isOpen, onClose }: UsageModalProps) {
  // Last successful usage snapshot; kept while a refresh is in flight so the bars do not blank.
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  // Error text from the latest failed load, shown in place of (or above) the bars.
  const [error, setError] = useState<string | null>(null);
  // Drives the refresh spinner and disables the refresh button mid-request.
  const [isLoading, setIsLoading] = useState(false);
  // Codex's last reported limits; null until loaded or when the lookup failed (the section is then hidden).
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null);

  const loadCodexUsage = useCallback(async () => {
    try {
      const response = await api.providers.codexPlanUsage();
      const payload = await response.json();
      setCodexUsage(response.ok && payload?.success ? (payload.data as CodexUsage) : null);
    } catch {
      // Codex is optional: a failed lookup just leaves its section out.
      setCodexUsage(null);
    }
  }, []);

  const loadUsage = useCallback(async (refresh: boolean) => {
    setIsLoading(true);
    void loadCodexUsage();
    try {
      const response = await api.providers.claudePlanUsage(refresh);
      const payload = await response.json();
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
      }
      setUsage(payload.data as PlanUsage);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [loadCodexUsage]);

  useEffect(() => {
    if (isOpen) {
      void loadUsage(false);
    }
  }, [isOpen, loadUsage]);

  const now = Date.now();
  const planName = usage ? formatPlanName(usage) : null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(92vw,28rem)] p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <DialogTitle className="not-sr-only text-base font-semibold text-foreground">Usage</DialogTitle>
          <button
            type="button"
            onClick={() => void loadUsage(true)}
            disabled={isLoading}
            aria-label="Refresh usage"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-red-300/60 bg-red-50/80 px-3 py-2 text-xs text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300">
            {error}
          </div>
        )}

        {!usage && !error && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}

        {usage && (
          <div className="space-y-4">
            <SectionHeading title="Claude" subtitle={planName} />
            <LimitBars limits={usage.limits} now={now} />

            {usage.extraUsage?.enabled && (
              <div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-foreground">Extra usage</span>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {formatMoney(usage.extraUsage.usedMinor, usage.extraUsage.currency, usage.extraUsage.exponent)}
                    {usage.extraUsage.limitMinor !== null &&
                      ` / ${formatMoney(usage.extraUsage.limitMinor, usage.extraUsage.currency, usage.extraUsage.exponent)}`}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Billed only after a plan limit is reached.</p>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground/70">Updated {formatClock(usage.fetchedAt)}</p>
          </div>
        )}

        {codexUsage?.connected && (
          <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
            <SectionHeading
              title="Codex"
              subtitle={codexUsage.planType ? `ChatGPT ${codexUsage.planType[0].toUpperCase()}${codexUsage.planType.slice(1)}` : null}
            />
            {codexUsage.limits.length > 0 ? (
              <LimitBars limits={codexUsage.limits} now={now} />
            ) : (
              <p className="text-xs text-muted-foreground">No usage reported yet. Codex reports its limits after a turn.</p>
            )}
            {codexUsage.reportedAt && (
              <p className="text-[11px] text-muted-foreground/70">
                As of Codex's last turn, {formatClock(codexUsage.reportedAt)}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
