import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';

export type NestedRepoSummary = {
  /** Path relative to the project folder; '.' when the project itself is the repo. */
  path: string;
  name: string;
  branch: string | null;
  changes: number;
  ahead: number;
  behind: number;
  isWorktree: boolean;
  error?: string;
};

type ReposResponse = { repos?: NestedRepoSummary[]; nested?: boolean; error?: string };

const STORAGE_PREFIX = 'cloudcli:git-repo:';

function readStoredRepo(projectId: string): string | null {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${projectId}`);
  } catch {
    return null;
  }
}

function storeRepo(projectId: string, repo: string) {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, repo);
  } catch {
    // per-viewer convenience only
  }
}

/**
 * Detects git repositories nested inside a project folder that is not itself a
 * repo (e.g. a task folder with `golfn-api/` and `golfn-app/` worktrees) and
 * tracks which one the Source Control panel is showing.
 */
export function useNestedRepos(projectId: string | null) {
  const [repos, setRepos] = useState<NestedRepoSummary[]>([]);
  const [isNested, setIsNested] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  const refreshRepos = useCallback(async (signal?: AbortSignal) => {
    if (!projectId) return;
    try {
      const response = await api.git.repos(projectId, { signal });
      const data = (await response.json()) as ReposResponse;
      if (signal?.aborted) return;
      const list = data.repos ?? [];
      setRepos(list);
      setIsNested(Boolean(data.nested));
      setSelectedRepo((current) => {
        if (!data.nested) return null;
        if (current && list.some((repo) => repo.path === current)) return current;
        const stored = readStoredRepo(projectId);
        if (stored && list.some((repo) => repo.path === stored)) return stored;
        // Prefer a repo with uncommitted work, then the first one.
        return (list.find((repo) => repo.changes > 0) ?? list[0])?.path ?? null;
      });
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') {
        console.error('Failed to list repositories:', error);
      }
    } finally {
      if (!signal?.aborted) setIsLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    setRepos([]);
    setIsNested(false);
    setSelectedRepo(null);
    setIsLoaded(false);
    const controller = new AbortController();
    void refreshRepos(controller.signal);
    return () => controller.abort();
  }, [refreshRepos]);

  const selectRepo = useCallback((repo: string) => {
    setSelectedRepo(repo);
    if (projectId) storeRepo(projectId, repo);
  }, [projectId]);

  return { repos, isNested, selectedRepo, selectRepo, refreshRepos, isLoaded };
}
