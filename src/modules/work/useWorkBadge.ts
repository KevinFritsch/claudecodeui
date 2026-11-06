import { useEffect, useState } from 'react';

import { workApi } from '@/modules/work/api';

const POLL_MS = 60_000;
export const WORK_SEEN_EVENT = 'work:seen';

/**
 * Number of new Work items (Slack mentions, Jira tasks) since the user last
 * had the Work tab open. Polls while another tab is showing; the panel fires
 * WORK_SEEN_EVENT after marking items seen, which clears it.
 */
export function useWorkBadge(projectPath: string | null | undefined, enabled: boolean, isWorkTabActive: boolean): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const clear = () => setCount(0);
    window.addEventListener(WORK_SEEN_EVENT, clear);
    return () => window.removeEventListener(WORK_SEEN_EVENT, clear);
  }, []);

  useEffect(() => {
    if (!enabled || !projectPath) {
      setCount(0);
      return undefined;
    }
    if (isWorkTabActive) return undefined;
    let cancelled = false;
    const check = () => {
      if (document.visibilityState === 'hidden') return;
      workApi.badge(projectPath)
        .then((data) => {
          if (!cancelled) setCount(data.count);
        })
        .catch(() => undefined);
    };
    check();
    const timer = window.setInterval(check, POLL_MS);
    window.addEventListener('focus', check);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [enabled, isWorkTabActive, projectPath]);

  return count;
}
