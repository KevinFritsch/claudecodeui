// Kvn: Jira status and sprint badges, shared by the Work panel and the session bar's quick actions.
import { cn } from '@/shared/utils';
import type { JiraTask } from '@/modules/work/api';

export const STATUS_STYLES: Record<string, string> = {
  'in progress': 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  'change requested': 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  'to do': 'bg-muted text-muted-foreground',
  'pull request': 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'pending information': 'bg-muted text-muted-foreground',
  qa: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  'qa app': 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  done: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide', STATUS_STYLES[status.toLowerCase()] ?? 'bg-muted text-muted-foreground')}>
      {status}
    </span>
  );
}

/** "GOL Sprint 87" → "Sprint 87": the project prefix is noise inside the project's own dashboard. */
function shortSprintName(name: string): string {
  const match = name.match(/sprint\s*\d+/i);
  return match ? match[0].replace(/^sprint/i, 'Sprint') : name;
}

export function SprintBadge({ task }: { task: JiraTask }) {
  if (!task.sprint) {
    return (
      <span className="inline-flex shrink-0 items-center rounded border border-dashed border-muted-foreground/40 px-1.5 py-px text-[10px] font-medium text-muted-foreground" title="Not in a sprint">
        Backlog
      </span>
    );
  }
  const isActive = task.sprint.state === 'active';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10px] font-medium',
        isActive ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' : 'bg-muted text-muted-foreground',
      )}
      title={isActive ? `In the current sprint (${task.sprint.name})` : `Planned for ${task.sprint.name}`}
    >
      {isActive ? '● ' : ''}{shortSprintName(task.sprint.name)}{isActive ? '' : ' (next)'}
    </span>
  );
}

const STATUS_DOTS: Record<string, string> = {
  'in progress': 'bg-blue-500',
  'change requested': 'bg-amber-500',
  'to do': 'bg-muted-foreground/50',
  'pull request': 'bg-violet-500',
  'pending information': 'bg-muted-foreground/50',
  qa: 'bg-emerald-500',
  'qa app': 'bg-emerald-500',
  done: 'bg-emerald-600',
};

/** Dot color for a status on a session chip; null when the task is off the board. */
export function statusDotClass(status: string | null | undefined): string | null {
  return status ? STATUS_DOTS[status.toLowerCase()] ?? 'bg-muted-foreground/50' : null;
}
