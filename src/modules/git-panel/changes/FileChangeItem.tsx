import { ChevronRight, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { FileStatusCode } from '@/shared/types';
import { getStatusBadgeClass, getStatusLabelKey } from '@/modules/git-panel/utils/gitPanelUtils';
import GitDiffViewer from '@/modules/git-panel/GitDiffViewer';

type FileChangeItemProps = {
  filePath: string;
  status: FileStatusCode;
  isMobile: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  diff?: string;
  wrapText: boolean;
  onToggleSelected: (filePath: string) => void;
  onToggleExpanded: (filePath: string) => void;
  onOpenFile: (filePath: string) => void;
  onToggleWrapText: () => void;
  onRequestFileAction: (filePath: string, status: FileStatusCode) => void;
};

/** Rendered by FileChangeList for one changed file, with its status badge, row actions and expandable diff. */
export default function FileChangeItem({
  filePath,
  status,
  isMobile,
  isExpanded,
  isSelected,
  diff,
  wrapText,
  onToggleSelected,
  onToggleExpanded,
  onOpenFile,
  onToggleWrapText,
  onRequestFileAction,
}: FileChangeItemProps) {
  const { t } = useTranslation();
  const statusLabel = t(getStatusLabelKey(status));
  const badgeClass = getStatusBadgeClass(status);
  const slash = filePath.lastIndexOf('/');
  const directory = slash >= 0 ? filePath.slice(0, slash + 1) : '';
  const fileName = filePath.slice(slash + 1);
  const counts = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const line of (diff ?? '').split('\n')) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
    return { added, removed };
  }, [diff]);

  return (
    <div className="border-b border-border last:border-0">
      {/* Kvn: an open file's header sticks under the toolbar (Bitbucket-style), so collapsing is one click away. */}
      <div
        className={`flex items-center transition-colors hover:bg-accent/50 ${isMobile ? 'px-2 py-1.5' : 'px-3 py-1.5'} ${
          isExpanded ? 'sticky top-8 z-10 border-b border-border/60 bg-muted/90 backdrop-blur' : ''
        }`}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelected(filePath)}
          onClick={(event) => event.stopPropagation()}
          className={`rounded border-border bg-background text-primary checked:bg-primary focus:ring-primary/40 ${isMobile ? 'mr-1.5' : 'mr-2'}`}
        />

        <div className="flex min-w-0 flex-1 items-center">
          <button
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpanded(filePath);
            }}
            className={`cursor-pointer rounded p-0.5 hover:bg-accent ${isMobile ? 'mr-1' : 'mr-2'}`}
            title={isExpanded ? t('git:item.collapseDiff') : t('git:item.expandDiff')}
          >
            <ChevronRight className={`h-3 w-3 transition-transform duration-200 ease-in-out ${isExpanded ? 'rotate-90' : 'rotate-0'}`} />
          </button>

          <span
            className={`flex-1 truncate ${isMobile ? 'text-xs' : 'text-sm'} cursor-pointer hover:text-primary hover:underline`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenFile(filePath);
            }}
            title={t('git:item.openFileTitle')}
          >
            {directory && <span className="text-muted-foreground">{directory}</span>}
            <span className={isExpanded ? 'font-semibold' : 'font-medium'}>{fileName}</span>
          </span>
          {(counts.added > 0 || counts.removed > 0) && (
            <span className="mr-2 shrink-0 font-mono text-[11px]">
              {counts.added > 0 && <span className="text-green-600 dark:text-green-400">+{counts.added}</span>}
              {counts.added > 0 && counts.removed > 0 && ' '}
              {counts.removed > 0 && <span className="text-red-600 dark:text-red-400">−{counts.removed}</span>}
            </span>
          )}

          <span className="flex items-center gap-1">
            {(status === 'M' || status === 'D' || status === 'U') && (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onRequestFileAction(filePath, status);
                }}
                className={`${isMobile ? 'px-2 py-1 text-xs' : 'p-1'} flex items-center gap-1 rounded font-medium text-destructive hover:bg-destructive/10`}
                title={status === 'U' ? t('git:item.deleteUntrackedTitle') : t('git:item.discardChangesTitle')}
              >
                <Trash2 className="h-3 w-3" />
                {isMobile && <span>{status === 'U' ? t('git:item.deleteShort') : t('git:item.discardShort')}</span>}
              </button>
            )}

            <span
              className={`inline-flex h-5 w-5 items-center justify-center rounded border text-[10px] font-bold ${badgeClass}`}
              title={statusLabel}
            >
              {status}
            </span>
          </span>
        </div>
      </div>

      <div
        className={`duration-400 overflow-hidden bg-muted/50 transition-all ease-in-out ${isExpanded && diff ? 'max-h-none translate-y-0 opacity-100' : 'max-h-0 -translate-y-1 opacity-0'
          }`}
      >
        {isMobile && (
        <div className="flex items-center justify-between border-b border-border p-2">
          <span className="flex items-center gap-2">
            <span className={`inline-flex h-5 w-5 items-center justify-center rounded border text-[10px] font-bold ${badgeClass}`}>
              {status}
            </span>
            <span className="text-sm font-medium text-foreground">{statusLabel}</span>
          </span>
          {isMobile && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                onToggleWrapText();
              }}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              title={wrapText ? t('git:item.switchToScroll') : t('git:item.switchToWrap')}
            >
              {wrapText ? t('git:item.scroll') : t('git:item.wrap')}
            </button>
          )}
        </div>
        )}

        {/* Kvn: full height (no box-in-a-box scrolling), so "Expand all" reads like one long diff. */}
        <div>
          {diff && <GitDiffViewer diff={diff} filePath={filePath} isMobile={isMobile} wrapText={wrapText} />}
        </div>
      </div>
    </div>
  );
}
