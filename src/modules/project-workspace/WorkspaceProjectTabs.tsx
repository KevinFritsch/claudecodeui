import { X } from 'lucide-react';

import { useProjectColors } from '@/shared/hooks/useProjectColors';
import { cn, withAlpha } from '@/shared/utils';

type ProjectTab = {
  projectId: string | null;
  label: string;
  sessionCount: number;
  isActive: boolean;
};

type WorkspaceProjectTabsProps = {
  tabs: ProjectTab[];
  onSelect: (projectId: string | null) => void;
  onClose: (projectId: string | null) => void;
};

/**
 * Rendered by WorkspaceMain above the chat area: one tab per project, each
 * keeping its own split of sessions. The active tab carries its project's
 * colour; a tab can be closed once there is another to fall back to.
 */
export default function WorkspaceProjectTabs({ tabs, onSelect, onClose }: WorkspaceProjectTabsProps) {
  const { getProjectColor } = useProjectColors();
  if (tabs.length === 0) return null;
  const canClose = tabs.length > 1;

  return (
    <div
      role="tablist"
      aria-label="Project tabs"
      className="scrollbar-hide flex flex-shrink-0 items-end gap-1 overflow-x-auto border-b border-border/60 bg-muted/20 px-2 pt-1.5"
    >
      {tabs.map((tab) => {
        const color = getProjectColor(tab.projectId, tab.label);
        return (
          <div
            key={tab.projectId ?? 'unassigned'}
            role="tab"
            aria-selected={tab.isActive}
            tabIndex={0}
            onClick={() => onSelect(tab.projectId)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(tab.projectId);
              }
            }}
            onAuxClick={(event) => {
              // Middle-click closes, like browser tabs.
              if (event.button === 1 && canClose) onClose(tab.projectId);
            }}
            className={cn(
              'group relative flex max-w-[220px] cursor-pointer select-none items-center gap-2 rounded-t-lg border border-b-0 px-3 py-1.5 text-xs font-medium transition-colors',
              tab.isActive
                ? 'border-border/70 bg-background text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
            style={tab.isActive ? { boxShadow: `inset 0 2px 0 ${color}` } : undefined}
            title={tab.label}
          >
            <span
              className="h-2 w-2 flex-shrink-0 rounded-full"
              style={{ backgroundColor: color, boxShadow: `0 0 0 2px ${withAlpha(color, 0.2)}` }}
              aria-hidden
            />
            <span className="truncate">{tab.label}</span>
            {tab.sessionCount > 1 && (
              <span className="rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">{tab.sessionCount}</span>
            )}
            {canClose && (
              <button
                type="button"
                aria-label={`Close ${tab.label} tab`}
                title="Close tab"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.projectId);
                }}
                className={cn(
                  'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground',
                  tab.isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
                )}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
