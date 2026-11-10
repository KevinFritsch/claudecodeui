import { ChevronsDownUp, ChevronsUpDown, GitBranch, GitCommit, Info, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ConfirmationRequest, FileStatusCode, GitDiffMap, GitStatusResponse } from '@/shared/types';
import { getAllChangedFiles, hasChangedFiles } from '@/modules/git-panel/utils/gitPanelUtils';
import CommitComposer from '@/modules/git-panel/changes/CommitComposer';
import FileChangeList from '@/modules/git-panel/changes/FileChangeList';

type ChangesViewProps = {
  isMobile: boolean;
  projectPath: string;
  gitStatus: GitStatusResponse | null;
  gitDiff: GitDiffMap;
  isLoading: boolean;
  wrapText: boolean;
  isCreatingInitialCommit: boolean;
  onWrapTextChange: (wrapText: boolean) => void;
  onCreateInitialCommit: () => Promise<boolean>;
  onOpenFile: (filePath: string) => Promise<void>;
  onDiscardFile: (filePath: string) => Promise<void>;
  onDeleteFile: (filePath: string) => Promise<void>;
  onStageFiles: (files: string[]) => Promise<boolean>;
  onUnstageFiles: (files: string[]) => Promise<boolean>;
  onCommitChanges: (message: string, files: string[]) => Promise<boolean>;
  onRequestConfirmation: (request: ConfirmationRequest) => void;
  onExpandedFilesChange: (hasExpandedFiles: boolean) => void;
};

/** Rendered by GitPanel for the Changes tab, listing working-tree changes and hosting the commit composer. */
export default function ChangesView({
  isMobile,
  projectPath,
  gitStatus,
  gitDiff,
  isLoading,
  wrapText,
  isCreatingInitialCommit,
  onWrapTextChange,
  onCreateInitialCommit,
  onOpenFile,
  onDiscardFile,
  onDeleteFile,
  onStageFiles,
  onUnstageFiles,
  onCommitChanges,
  onRequestConfirmation,
  onExpandedFilesChange,
}: ChangesViewProps) {
  const { t } = useTranslation();
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  // Stage/unstage calls in flight or queued. While > 0, status refreshes must
  // not overwrite the optimistic selection with a snapshot that predates the
  // later clicks.
  const [pendingStageOps, setPendingStageOps] = useState(0);
  // Serializes stage/unstage requests so rapid toggles cannot interleave on
  // the server or resolve out of order.
  const stageOpQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  const changedFiles = useMemo(() => getAllChangedFiles(gitStatus), [gitStatus]);
  const hasExpandedFiles = expandedFiles.size > 0;

  const enqueueStageOp = useCallback((operation: () => Promise<unknown>) => {
    setPendingStageOps((count) => count + 1);
    stageOpQueueRef.current = stageOpQueueRef.current
      .catch(() => {}) // a failed op must not block the queue
      .then(operation)
      .finally(() => setPendingStageOps((count) => count - 1));
  }, []);

  useEffect(() => {
    if (!gitStatus || gitStatus.error) {
      setSelectedFiles(new Set());
      return;
    }

    if (pendingStageOps > 0) {
      return; // keep the optimistic state until the queued ops settle
    }

    // The Staged section mirrors the real git index reported by /status, so
    // files staged outside the app (VSCode, terminal) show up here too. Also
    // re-runs when the queue drains, syncing to the final refreshed status.
    setSelectedFiles(new Set(gitStatus.staged ?? []));
  }, [gitStatus, pendingStageOps]);

  useEffect(() => {
    onExpandedFilesChange(hasExpandedFiles);
  }, [hasExpandedFiles, onExpandedFilesChange]);

  useEffect(() => {
    return () => {
      onExpandedFilesChange(false);
    };
  }, [onExpandedFilesChange]);

  const lineTotals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const filePath of changedFiles) {
      for (const line of (gitDiff[filePath] ?? '').split('\n')) {
        if (line.startsWith('+')) added += 1;
        else if (line.startsWith('-')) removed += 1;
      }
    }
    return { added, removed };
  }, [changedFiles, gitDiff]);

  const allExpanded = changedFiles.length > 0 && changedFiles.every((filePath) => expandedFiles.has(filePath));
  const toggleExpandAll = useCallback(() => {
    setExpandedFiles(allExpanded ? new Set() : new Set(changedFiles));
  }, [allExpanded, changedFiles]);

  const toggleFileExpanded = useCallback((filePath: string) => {
    setExpandedFiles((previous) => {
      const next = new Set(previous);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  // Staging is real: every toggle runs git add / git reset through the API.
  // The set is flipped optimistically; the queued API call keeps the git
  // index in sync and the final status refresh re-syncs once the queue drains.
  const toggleFileSelected = useCallback(
    (filePath: string) => {
      const isStaged = selectedFiles.has(filePath);
      setSelectedFiles((previous) => {
        const next = new Set(previous);
        if (isStaged) {
          next.delete(filePath);
        } else {
          next.add(filePath);
        }
        return next;
      });
      enqueueStageOp(() => (isStaged ? onUnstageFiles([filePath]) : onStageFiles([filePath])));
    },
    [enqueueStageOp, onStageFiles, onUnstageFiles, selectedFiles],
  );

  const requestFileAction = useCallback(
    (filePath: string, status: FileStatusCode) => {
      if (status === 'U') {
        onRequestConfirmation({
          type: 'delete',
          message: t('git:changes.confirmDeleteFile', { path: filePath }),
          onConfirm: async () => {
            await onDeleteFile(filePath);
          },
        });
        return;
      }

      onRequestConfirmation({
        type: 'discard',
        message: t('git:changes.confirmDiscard', { path: filePath }),
        onConfirm: async () => {
          await onDiscardFile(filePath);
        },
      });
    },
    [onDeleteFile, onDiscardFile, onRequestConfirmation, t],
  );

  const commitSelectedFiles = useCallback(
    (message: string) => {
      return onCommitChanges(message, Array.from(selectedFiles));
    },
    [onCommitChanges, selectedFiles],
  );

  const unstagedFiles = useMemo(
    () => new Set(changedFiles.filter((f) => !selectedFiles.has(f))),
    [changedFiles, selectedFiles],
  );

  return (
    <>
      <CommitComposer
        isMobile={isMobile}
        projectPath={projectPath}
        selectedFileCount={selectedFiles.size}
        isHidden={false}
        onCommit={commitSelectedFiles}
        onRequestConfirmation={onRequestConfirmation}
      />

      <div className="flex-1 overflow-y-auto">
        {/* Kvn: always-reachable toolbar (sticky), so expanded diffs never trap you at the bottom. */}
        {!isLoading && changedFiles.length > 0 && (
          <div className="sticky top-0 z-20 flex h-8 items-center gap-3 border-b border-border/60 bg-background/95 px-3 text-xs text-muted-foreground backdrop-blur">
            <span className="font-medium text-foreground/80">{changedFiles.length} file{changedFiles.length > 1 ? 's' : ''}</span>
            {(lineTotals.added > 0 || lineTotals.removed > 0) && (
              <span className="font-mono">
                <span className="text-green-600 dark:text-green-400">+{lineTotals.added}</span>{' '}
                <span className="text-red-600 dark:text-red-400">−{lineTotals.removed}</span>
              </span>
            )}
            <span
              className="inline-flex cursor-help items-center"
              title="M modified · A added · D deleted · U untracked. Tick a file to stage it."
            >
              <Info className="h-3.5 w-3.5" />
            </span>
            <button
              type="button"
              onClick={toggleExpandAll}
              className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground/80 hover:bg-accent hover:text-foreground"
            >
              {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          </div>
        )}
        {isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : gitStatus?.hasCommits === false && hasChangedFiles(gitStatus) ? (
          <div className="flex flex-col items-center justify-center p-8 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50">
              <GitBranch className="h-7 w-7 text-muted-foreground/50" />
            </div>
            <h3 className="mb-2 text-lg font-medium text-foreground">{t('git:changes.noCommitsTitle')}</h3>
            <p className="mb-6 max-w-md text-sm text-muted-foreground">
              {t('git:changes.noCommitsDescription')}
            </p>
            <button
              onClick={() => void onCreateInitialCommit()}
              disabled={isCreatingInitialCommit}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreatingInitialCommit ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  <span>{t('git:changes.creatingInitial')}</span>
                </>
              ) : (
                <>
                  <GitCommit className="h-4 w-4" />
                  <span>{t('git:changes.createInitial')}</span>
                </>
              )}
            </button>
          </div>
        ) : !gitStatus || !hasChangedFiles(gitStatus) ? (
          <div className="flex h-32 flex-col items-center justify-center text-muted-foreground">
            <GitCommit className="mb-2 h-10 w-10 opacity-40" />
            <p className="text-sm">{t('git:changes.noChanges')}</p>
          </div>
        ) : (
          <div className={isMobile ? 'pb-4' : ''}>
            {/* STAGED section */}
            <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-1.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('git:changes.stagedCount', { n: selectedFiles.size })}
              </span>
              {selectedFiles.size > 0 && (
                <button
                  onClick={() => {
                    const filesToUnstage = Array.from(selectedFiles);
                    setSelectedFiles(new Set());
                    enqueueStageOp(() => onUnstageFiles(filesToUnstage));
                  }}
                  className="text-xs text-primary transition-colors hover:text-primary/80"
                >
                  {t('git:changes.unstageAll')}
                </button>
              )}
            </div>
            {selectedFiles.size === 0 ? (
              <div className="px-3 py-2 text-xs italic text-muted-foreground">{t('git:changes.noStagedFiles')}</div>
            ) : (
              <FileChangeList
                gitStatus={gitStatus}
                gitDiff={gitDiff}
                expandedFiles={expandedFiles}
                selectedFiles={selectedFiles}
                isMobile={isMobile}
                wrapText={wrapText}
                filePaths={selectedFiles}
                onToggleSelected={toggleFileSelected}
                onToggleExpanded={toggleFileExpanded}
                onOpenFile={(filePath) => { void onOpenFile(filePath); }}
                onToggleWrapText={() => onWrapTextChange(!wrapText)}
                onRequestFileAction={requestFileAction}
              />
            )}

            {/* CHANGES section */}
            <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-1.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('git:changes.changesCount', { n: unstagedFiles.size })}
              </span>
              {unstagedFiles.size > 0 && (
                <button
                  onClick={() => {
                    const filesToStage = Array.from(unstagedFiles);
                    setSelectedFiles(new Set(changedFiles));
                    enqueueStageOp(() => onStageFiles(filesToStage));
                  }}
                  className="text-xs text-primary transition-colors hover:text-primary/80"
                >
                  {t('git:changes.stageAll')}
                </button>
              )}
            </div>
            {unstagedFiles.size === 0 ? (
              <div className="px-3 py-2 text-xs italic text-muted-foreground">{t('git:changes.allStaged')}</div>
            ) : (
              <FileChangeList
                gitStatus={gitStatus}
                gitDiff={gitDiff}
                expandedFiles={expandedFiles}
                selectedFiles={selectedFiles}
                isMobile={isMobile}
                wrapText={wrapText}
                filePaths={unstagedFiles}
                onToggleSelected={toggleFileSelected}
                onToggleExpanded={toggleFileExpanded}
                onOpenFile={(filePath) => { void onOpenFile(filePath); }}
                onToggleWrapText={() => onWrapTextChange(!wrapText)}
                onRequestFileAction={requestFileAction}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}
