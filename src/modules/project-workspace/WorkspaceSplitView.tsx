import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, ReactNode } from 'react';
import { Folder, GitBranch, MessageSquare, MessageSquarePlus, Terminal, X } from 'lucide-react';

import { LLMProviderLogo } from '@/shared/ui';
import { cn, withAlpha } from '@/shared/utils';
import { useProjectColors } from '@/shared/hooks/useProjectColors';
import { SESSION_DRAG_MIME } from '@/shared/constants';
import type { ResolvedSplitPane, SessionDragPayload, SplitDropTarget, SplitPaneTab } from '@/shared/types';

type WorkspaceSplitViewProps = {
  panes: ResolvedSplitPane[];
  /** Whether the chat tab is showing; the split view stays mounted but hidden on other tabs. */
  isVisible: boolean;
  onFocusPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onDropSession: (payload: SessionDragPayload, target: SplitDropTarget) => void;
  onPaneTabChange: (paneId: string, tab: SplitPaneTab) => void;
  /** Renders a pane's body for its current tab (chat, shell, files or source control). */
  renderPane: (pane: ResolvedSplitPane) => ReactNode;
};

const PANE_TABS: Array<{ tab: SplitPaneTab; label: string; Icon: typeof Folder }> = [
  { tab: 'chat', label: 'Chat', Icon: MessageSquare },
  { tab: 'shell', label: 'Shell', Icon: Terminal },
  { tab: 'files', label: 'Files', Icon: Folder },
  { tab: 'git', label: 'Source Control', Icon: GitBranch },
];

/** Share of the width/height, from each edge, that drops into a half; where two edges meet it is a corner. */
const EDGE_ZONE = 0.25;

const CELL_LABELS: Record<string, string> = {
  '0': 'Top left',
  '1': 'Top right',
  '2': 'Bottom left',
  '3': 'Bottom right',
  '0,2': 'Left half',
  '1,3': 'Right half',
  '0,1': 'Top half',
  '2,3': 'Bottom half',
};

const sortedKey = (cells: number[]) => [...cells].sort((a, b) => a - b).join(',');

/** Converts a rectangle of grid cells to its CSS grid placement (as percentages for the drop preview). */
function cellBounds(cells: number[]) {
  const columns = cells.map((cell) => cell % 2);
  const rows = cells.map((cell) => Math.floor(cell / 2));
  const column = Math.min(...columns);
  const row = Math.min(...rows);
  return {
    column,
    row,
    columnSpan: Math.max(...columns) - column + 1,
    rowSpan: Math.max(...rows) - row + 1,
  };
}

function gridPlacement(cells: number[]): CSSProperties {
  const { column, row, columnSpan, rowSpan } = cellBounds(cells);
  return {
    gridColumn: `${column + 1} / span ${columnSpan}`,
    gridRow: `${row + 1} / span ${rowSpan}`,
  };
}

function previewPlacement(cells: number[]): CSSProperties {
  const { column, row, columnSpan, rowSpan } = cellBounds(cells);
  return {
    left: `${column * 50}%`,
    top: `${row * 50}%`,
    width: `${columnSpan * 50}%`,
    height: `${rowSpan * 50}%`,
  };
}

function paneTitle(pane: ResolvedSplitPane): string {
  const session = pane.session;
  if (!session) return 'New session';
  const title = [session.summary, session.title, session.name].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  return title ?? 'Untitled session';
}

const isSessionDrag = (event: DragEvent) => event.dataTransfer.types.includes(SESSION_DRAG_MIME);

/**
 * Rendered by WorkspaceMain in place of the single chat: lays chat panes out
 * on a 2×2 grid (halves and corners) and, while a session is dragged in from
 * the sidebar, previews where it will land: an edge opens it in that half, a
 * corner in that corner, and the middle of a pane replaces that pane's chat.
 */
export default function WorkspaceSplitView({
  panes,
  isVisible,
  onFocusPane,
  onClosePane,
  onDropSession,
  onPaneTabChange,
  renderPane,
}: WorkspaceSplitViewProps) {
  const { getProjectColor } = useProjectColors();
  const containerRef = useRef<HTMLDivElement>(null);
  // Where the dragged session would land; null when no session drag is over the view.
  const [dropTarget, setDropTarget] = useState<SplitDropTarget | null>(null);

  const isSplit = panes.length > 1;

  const targetFromPointer = useCallback((event: DragEvent): SplitDropTarget | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const isLeft = x < EDGE_ZONE;
    const isRight = x > 1 - EDGE_ZONE;
    const isTop = y < EDGE_ZONE;
    const isBottom = y > 1 - EDGE_ZONE;

    if ((isLeft || isRight) && (isTop || isBottom)) {
      return { kind: 'cells', cells: [(isTop ? 0 : 2) + (isLeft ? 0 : 1)] };
    }
    if (isLeft) return { kind: 'cells', cells: [0, 2] };
    if (isRight) return { kind: 'cells', cells: [1, 3] };
    if (isTop) return { kind: 'cells', cells: [0, 1] };
    if (isBottom) return { kind: 'cells', cells: [2, 3] };

    const cellUnderPointer = (y < 0.5 ? 0 : 2) + (x < 0.5 ? 0 : 1);
    const pane = panes.find((candidate) => candidate.cells.includes(cellUnderPointer));
    return pane ? { kind: 'pane', paneId: pane.paneId } : null;
  }, [panes]);

  const handleDragOver = useCallback((event: DragEvent) => {
    if (!isSessionDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const target = targetFromPointer(event);
    setDropTarget((previous) => {
      if (!target || !previous || previous.kind !== target.kind) return target;
      const unchanged = target.kind === 'pane'
        ? previous.kind === 'pane' && previous.paneId === target.paneId
        : previous.kind === 'cells' && sortedKey(previous.cells) === sortedKey(target.cells);
      return unchanged ? previous : target;
    });
  }, [targetFromPointer]);

  const handleDragLeave = useCallback((event: DragEvent) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && containerRef.current?.contains(nextTarget)) return;
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback((event: DragEvent) => {
    if (!isSessionDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = targetFromPointer(event);
    setDropTarget(null);
    if (!target) return;
    try {
      const payload = JSON.parse(event.dataTransfer.getData(SESSION_DRAG_MIME)) as SessionDragPayload;
      if (typeof payload?.sessionId === 'string' && payload.sessionId) {
        onDropSession(payload, target);
      }
    } catch (error) {
      console.error('Ignoring malformed session drop:', error);
    }
  }, [onDropSession, targetFromPointer]);

  // A drag cancelled outside the view (Escape, dropped on the sidebar) never
  // fires dragleave here, so clear the preview whenever any drag ends.
  useEffect(() => {
    const clear = () => setDropTarget(null);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, []);

  const previewCells = dropTarget?.kind === 'cells'
    ? dropTarget.cells
    : dropTarget?.kind === 'pane'
      ? panes.find((pane) => pane.paneId === dropTarget.paneId)?.cells ?? null
      : null;
  const previewLabel = dropTarget?.kind === 'cells'
    ? CELL_LABELS[sortedKey(dropTarget.cells)]
    : isSplit ? 'Replace this chat' : 'Open here';

  return (
    <div
      ref={containerRef}
      className={cn('relative h-full', !isVisible && 'hidden')}
      // Capture phase: a session drag must not reach the composer's file
      // dropzone or a textarea, which would paste the row's link.
      onDragEnterCapture={handleDragOver}
      onDragOverCapture={handleDragOver}
      onDragLeave={handleDragLeave}
      onDropCapture={handleDrop}
    >
      <div className={cn('grid h-full grid-cols-2 grid-rows-2', isSplit && 'gap-px bg-border/70')}>
        {panes.map((pane) => {
          const hasChat = Boolean(pane.session) || pane.isFocused;
          // The focused pane is outlined in its project's colour, so in a split
          // it is clear which project the header, tabs and URL now follow.
          const projectColor = pane.project
            ? getProjectColor(pane.project.projectId, pane.project.displayName)
            : null;
          const isHighlighted = isSplit && pane.isFocused && projectColor;
          return (
            <div
              key={pane.paneId}
              style={{
                ...gridPlacement(pane.cells),
                ...(isHighlighted ? { boxShadow: `inset 0 0 0 1px ${withAlpha(projectColor, 0.6)}` } : {}),
              }}
              className={cn(
                'relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background',
                isSplit && pane.isFocused && !projectColor && 'ring-1 ring-inset ring-primary/40',
              )}
              onPointerDownCapture={(event) => {
                // The close button must not focus the pane it is closing.
                if ((event.target as HTMLElement).closest('[data-pane-close]')) return;
                if (!pane.isFocused) onFocusPane(pane.paneId);
              }}
            >
              {isSplit && (
                <div
                  className={cn(
                    'flex h-8 flex-shrink-0 items-center gap-2 border-b border-border/60 px-2.5 text-xs',
                    pane.isFocused ? 'text-foreground' : 'bg-muted/30 text-muted-foreground',
                    pane.isFocused && !projectColor && 'bg-primary/5',
                  )}
                  style={isHighlighted ? {
                    backgroundColor: withAlpha(projectColor, 0.1),
                    boxShadow: `inset 0 2px 0 ${projectColor}`,
                  } : undefined}
                >
                  {pane.session && (
                    <LLMProviderLogo
                      provider={pane.session.__provider ?? 'claude'}
                      className="h-3 w-3 flex-shrink-0"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium" title={paneTitle(pane)}>
                    {hasChat ? paneTitle(pane) : 'Empty'}
                  </span>
                  {pane.project?.displayName && projectColor && (
                    <span className="flex min-w-0 max-w-[30%] flex-shrink-0 items-center gap-1.5" title={pane.project.displayName}>
                      <span
                        className="h-2 w-2 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: projectColor, boxShadow: `0 0 0 2px ${withAlpha(projectColor, 0.2)}` }}
                        aria-hidden
                      />
                      <span className="hidden truncate text-muted-foreground/80 xl:inline">{pane.project.displayName}</span>
                    </span>
                  )}
                  {hasChat && pane.project && (
                    <div role="tablist" aria-label="Pane view" className="flex flex-shrink-0 items-center gap-0.5">
                      {PANE_TABS.map(({ tab, label, Icon }) => (
                        <button
                          key={tab}
                          type="button"
                          role="tab"
                          aria-selected={pane.tab === tab}
                          aria-label={label}
                          title={label}
                          onClick={() => onPaneTabChange(pane.paneId, tab)}
                          className={cn(
                            'flex h-5 w-5 items-center justify-center rounded transition-colors',
                            pane.tab === tab
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                          )}
                        >
                          <Icon className="h-3 w-3" />
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label="Close pane"
                    title="Close pane"
                    className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    data-pane-close
                    onClick={() => onClosePane(pane.paneId)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              <div className="min-h-0 flex-1">
                {hasChat ? (
                  renderPane(pane)
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
                    <MessageSquarePlus className="h-6 w-6 opacity-60" />
                    <span>Drag a session from the sidebar here</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {previewCells && (
        <div className="pointer-events-none absolute inset-0 z-30 bg-background/30">
          <div
            className="absolute p-1.5 transition-all duration-100 ease-out"
            style={previewPlacement(previewCells)}
          >
            <div className="flex h-full w-full items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/15 text-sm font-medium text-primary">
              {previewLabel}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
