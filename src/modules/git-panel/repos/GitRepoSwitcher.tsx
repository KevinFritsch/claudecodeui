import { Check, ChevronDown, FolderGit2, GitBranch, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { NestedRepoSummary } from '@/modules/git-panel/hooks/useNestedRepos';

type GitRepoSwitcherProps = {
  repos: NestedRepoSummary[];
  selectedRepo: string | null;
  isMobile: boolean;
  onSelect: (repo: string) => void;
};

function RepoStats({ repo }: { repo: NestedRepoSummary }) {
  const { t } = useTranslation();
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs">
      {repo.ahead > 0 && <span className="text-green-600 dark:text-green-400">↑{repo.ahead}</span>}
      {repo.behind > 0 && <span className="text-primary">↓{repo.behind}</span>}
      {repo.changes > 0 && (
        <span
          className="min-w-[1.25rem] rounded-full bg-primary/15 px-1.5 text-center font-medium text-primary"
          title={t('git:repos.changes', { defaultValue: '{{count}} uncommitted changes', count: repo.changes })}
        >
          {repo.changes}
        </span>
      )}
    </span>
  );
}

/**
 * Repo picker for a project folder that holds several repos. Kvn: a one-line
 * switcher with a dropdown (the always-open list took the whole panel and
 * pushed the changes and diffs out of view).
 */
export default function GitRepoSwitcher({ repos, selectedRepo, isMobile, onSelect }: GitRepoSwitcherProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const selected = repos.find((repo) => repo.path === selectedRepo);
  const othersWithChanges = repos.filter((repo) => repo.path !== selectedRepo && repo.changes > 0).length;

  useEffect(() => {
    if (!isOpen) return undefined;
    setFilter('');
    const onDown = (event: MouseEvent | TouchEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? repos.filter((repo) => `${repo.name} ${repo.branch ?? ''}`.toLowerCase().includes(needle)) : repos;
  }, [filter, repos]);

  const pick = (path: string) => {
    onSelect(path);
    setIsOpen(false);
  };

  return (
    <div ref={boxRef} className={`relative border-b border-border/60 ${isMobile ? 'px-2 py-1.5' : 'px-3 py-1.5'}`}>
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60"
      >
        <FolderGit2 className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium">
              {selected?.name ?? t('git:repos.pick', { defaultValue: 'Pick a repository' })}
            </span>
            {selected?.branch && (
              <span className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
                <GitBranch className="h-3 w-3 shrink-0" />
                <span className="truncate">{selected.branch}</span>
              </span>
            )}
          </span>
        </span>
        {selected && <RepoStats repo={selected} />}
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {repos.length} repos{othersWithChanges > 0 ? ` · ${othersWithChanges} changed` : ''}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute left-2 right-2 top-full z-40 mt-1 rounded-lg border border-border bg-popover p-1.5 shadow-lg">
          {repos.length > 6 && (
            <div className="mb-1 flex items-center gap-1.5 rounded-md border border-border/70 px-2">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                autoFocus
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && shown[0]) pick(shown[0].path);
                }}
                placeholder={t('git:repos.filter', { defaultValue: 'Filter repositories…' })}
                className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </div>
          )}
          <ul role="listbox" className="max-h-[50vh] overflow-y-auto">
            {shown.map((repo) => {
              const isSelected = repo.path === selectedRepo;
              return (
                <li key={repo.path}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => pick(repo.path)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${isSelected ? 'bg-accent text-foreground' : 'text-foreground/85 hover:bg-accent/60'}`}
                  >
                    {isSelected ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : <span className="w-3.5 shrink-0" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{repo.name}</span>
                      <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                        <GitBranch className="h-3 w-3 shrink-0" />
                        <span className="truncate">{repo.branch ?? t('git:repos.noBranch', { defaultValue: 'no branch' })}</span>
                        {repo.isWorktree && (
                          <span className="shrink-0 rounded border border-border px-1 text-[10px] leading-4">
                            {t('git:repos.worktree', { defaultValue: 'worktree' })}
                          </span>
                        )}
                      </span>
                    </span>
                    <RepoStats repo={repo} />
                  </button>
                </li>
              );
            })}
            {shown.length === 0 && <li className="px-2 py-2 text-xs text-muted-foreground">No repository matches.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
