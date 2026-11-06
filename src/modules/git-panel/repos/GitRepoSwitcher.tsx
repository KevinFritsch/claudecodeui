import { ChevronDown, ChevronRight, FolderGit2, GitBranch } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { NestedRepoSummary } from '@/modules/git-panel/hooks/useNestedRepos';

type GitRepoSwitcherProps = {
  repos: NestedRepoSummary[];
  selectedRepo: string | null;
  isMobile: boolean;
  onSelect: (repo: string) => void;
};

/** VS Code-style "Repositories" list for a project folder that holds several repos. */
export default function GitRepoSwitcher({ repos, selectedRepo, isMobile, onSelect }: GitRepoSwitcherProps) {
  const { t } = useTranslation();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const selected = repos.find((repo) => repo.path === selectedRepo);

  return (
    <div className="border-b border-border/60">
      <button
        type="button"
        onClick={() => setIsCollapsed((value) => !value)}
        className={`flex w-full items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground ${isMobile ? 'px-3 py-1.5' : 'px-4 py-2'}`}
      >
        {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {t('git:repos.title', { defaultValue: 'Repositories' })}
        <span className="font-normal normal-case tracking-normal">({repos.length})</span>
        {isCollapsed && selected && (
          <span className="ml-auto truncate font-normal normal-case tracking-normal text-foreground">{selected.name}</span>
        )}
      </button>
      {!isCollapsed && (
        <ul className={`pb-1.5 ${isMobile ? 'px-1.5' : 'px-2'}`}>
          {repos.map((repo) => {
            const isSelected = repo.path === selectedRepo;
            return (
              <li key={repo.path}>
                <button
                  type="button"
                  onClick={() => onSelect(repo.path)}
                  aria-pressed={isSelected}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${isSelected ? 'bg-accent text-foreground' : 'text-foreground/80 hover:bg-accent/60'}`}
                >
                  <FolderGit2 className={`h-4 w-4 shrink-0 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
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
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
