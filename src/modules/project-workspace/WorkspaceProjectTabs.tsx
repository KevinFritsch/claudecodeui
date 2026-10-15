import type { CSSProperties } from 'react';
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
  const active = tabs.find((tab) => tab.isActive);
  const activeColor = active ? getProjectColor(active.projectId, active.label) : null;

  return (
    <div
      role="tablist"
      aria-label="Project tabs"
      className="scrollbar-hide flex flex-shrink-0 items-end gap-1 overflow-x-auto border-b-2 bg-muted/20 px-2 pt-1.5"
      // The bar's bottom edge takes the active project's colour.
      style={{ borderBottomColor: activeColor ? withAlpha(activeColor, 0.55) : undefined }}
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
              'group relative flex max-w-[220px] cursor-pointer select-none items-center gap-2 overflow-hidden rounded-t-lg border border-b-0 px-3.5 py-2 text-xs font-medium transition-colors',
              tab.isActive
                ? 'text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-[var(--tab-hover)] hover:text-foreground',
            )}
            style={{
              '--tab-hover': withAlpha(color, 0.1),
              ...(tab.isActive ? {
                backgroundColor: withAlpha(color, 0.16),
                borderColor: withAlpha(color, 0.45),
              } : {}),
            } as CSSProperties}
            title={tab.label}
          >
            {/* Project colour bar across the top: solid on the active tab, a hint on hover. */}
            <span
              className={cn(
                'pointer-events-none absolute inset-x-0 top-0 h-[3px] transition-opacity',
                tab.isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-50',
              )}
              style={{ backgroundColor: color }}
              aria-hidden
            />
            <span
              className="h-2 w-2 flex-shrink-0 rounded-full"
              style={{ backgroundColor: color, boxShadow: `0 0 0 2px ${withAlpha(color, 0.2)}` }}
              aria-hidden
            />
            <span className="truncate" style={tab.isActive ? { color } : undefined}>{tab.label}</span>
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
