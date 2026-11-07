import { Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { LLMProviderLogo } from '@/shared/ui';
import { cn, withAlpha } from '@/shared/utils';
import { useProjectColors } from '@/shared/hooks/useProjectColors';
import type { LLMProvider, RecentConversationListItem } from '@/shared/types';

const RECENT_LIMIT = 8;

function age(iso: string | null | undefined): string {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Kvn: the Quick access panel's main tab, the last few sessions across every project, one tap away. */
export default function QuickAccessRecent({
  isOpen,
  activeSessionId,
  onOpenSession,
}: {
  isOpen: boolean;
  activeSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const { getProjectColor } = useProjectColors();
  const [items, setItems] = useState<RecentConversationListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.recentConversations({ limit: RECENT_LIMIT, offset: 0 });
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { data?: { conversations?: RecentConversationListItem[] } };
      setItems(payload.data?.conversations ?? []);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fresh every time the panel opens: it is meant for "where was I".
  useEffect(() => {
    if (isOpen) void load();
  }, [isOpen, load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent sessions</span>
        <button
          type="button"
          onClick={() => void load()}
          aria-label="Refresh"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {failed && !items && <p className="px-2 py-3 text-xs text-destructive">Could not load recent sessions.</p>}
        {!items && !failed && (
          <div className="space-y-1.5 px-2 py-2">
            {Array.from({ length: 5 }, (_, i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted/60" />)}
          </div>
        )}
        {items?.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No sessions yet.</p>}
        <ul className="space-y-0.5">
          {items?.map((item) => {
            const color = getProjectColor(item.projectId, item.projectDisplayName ?? '');
            const isActive = item.sessionId === activeSessionId;
            return (
              <li key={item.sessionId}>
                <button
                  type="button"
                  onClick={() => onOpenSession(item.sessionId)}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent active:bg-accent/80',
                    isActive && 'bg-accent/70',
                  )}
                  style={isActive ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}
                >
                  <LLMProviderLogo provider={(item.provider || 'claude') as LLMProvider} className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{item.sessionTitle || 'Untitled session'}</span>
                    {item.topic && <span className="block truncate text-xs text-muted-foreground">{item.topic}</span>}
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span
                        className="h-2 w-2 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: color, boxShadow: `0 0 0 2px ${withAlpha(color, 0.2)}` }}
                        aria-hidden
                      />
                      <span className="truncate">{item.projectDisplayName ?? 'No project'}</span>
                      <span>· {age(item.lastActivity)}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
