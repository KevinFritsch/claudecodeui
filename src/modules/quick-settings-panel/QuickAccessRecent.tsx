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
            const isClaude = !item.provider || item.provider === 'claude';
            return (
              <li key={item.sessionId}>
                {/* Same language as the sidebar: a project-coloured node, the open
                    session tinted in its project colour, no repeated Claude logo. */}
                <button
                  type="button"
                  onClick={() => onOpenSession(item.sessionId)}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                    isActive ? '' : 'hover:bg-accent/50 active:bg-accent/70',
                  )}
                  style={isActive ? { backgroundColor: withAlpha(color, 0.13) } : undefined}
                >
                  <span className="flex h-5 w-2 flex-shrink-0 items-center justify-center">
                    {isActive ? (
                      <span className="h-3.5 w-[3px] rounded-full" style={{ backgroundColor: color }} />
                    ) : isClaude ? (
                      <span className="h-[6px] w-[6px] rounded-full" style={{ backgroundColor: withAlpha(color, 0.75) }} />
                    ) : (
                      <LLMProviderLogo provider={item.provider as LLMProvider} className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={cn('min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground', isActive && 'font-medium')}>
                        {item.sessionTitle || 'Untitled session'}
                      </span>
                      <span className="flex-shrink-0 text-[11px] text-muted-foreground">{age(item.lastActivity)}</span>
                    </span>
                    {item.topic && <span className="block truncate text-[11px] leading-4 text-muted-foreground/75">{item.topic}</span>}
                    <span className="mt-0.5 block truncate text-[11px] leading-4" style={{ color: withAlpha(color, 0.9) }}>
                      {item.projectDisplayName ?? 'No project'}
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
