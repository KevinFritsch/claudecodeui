import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from '@/shared/utils';
import type { Project } from '@/shared/types';
import { writeDraftText } from '@/shared/chatDrafts';
import { workApi, type JiraTask, type PullRequest, type Todo, type WorkConfig, type WorkItems, type WorkLink } from '@/modules/work/api';
import { setPendingWorkLink } from '@/modules/work/pendingWorkLink';
import { SessionButton, jiraSeed, todoSeed, type SessionActions } from '@/modules/work/SessionButton';
import SlackSection from '@/modules/work/SlackSection';

type WorkPanelProps = {
  project: Project;
  config: WorkConfig;
  isVisible: boolean;
  /** Opens an existing chat session in the Sessions view. */
  onOpenSession: (sessionId: string) => void;
  /** Opens a new, empty chat in this project (its composer shows the project draft). */
  onStartNewSession: () => void;
};

const AUTO_REFRESH_MS = 2 * 60_000;
const UNDO_WINDOW_MS = 8_000;

/** Statuses after which a task is waiting on review, so "Pull Request" is the natural next step once a PR exists. */
const PRE_REVIEW_STATUSES = new Set(['to do', 'in progress', 'change requested']);

function timeAgo(iso: string): string {
  const then = new Date(iso.replace(' ', 'T') + (iso.includes('T') || iso.endsWith('Z') ? '' : 'Z')).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function ageInDays(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

const STATUS_STYLES: Record<string, string> = {
  'in progress': 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  'change requested': 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  'to do': 'bg-muted text-muted-foreground',
  'pull request': 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'pending information': 'bg-muted text-muted-foreground',
  qa: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  'qa app': 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  done: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
};

function StatusBadge({ status }: { status: string }) {
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

function SprintBadge({ task }: { task: JiraTask }) {
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

type SprintFilter = 'all' | 'sprint' | 'backlog';

function SectionHeader({ title, count, right, open, onToggle }: { title: string; count?: number; right?: ReactNode; open?: boolean; onToggle?: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="flex items-center gap-2 px-1 pb-1.5 pt-1">
      {onToggle ? (
        <button type="button" onClick={onToggle} className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground">
          <Chevron className="h-3.5 w-3.5" />
          {title}
          {count !== undefined && <span className="font-normal normal-case text-muted-foreground/70">· {count}</span>}
        </button>
      ) : (
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
          {count !== undefined && <span className="ml-1 font-normal normal-case text-muted-foreground/70">· {count}</span>}
        </h3>
      )}
      <div className="ml-auto flex items-center gap-1">{right}</div>
    </div>
  );
}

function SourceError({ label, error }: { label: string; error: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{label} could not load: {error}</span>
    </div>
  );
}

/* ── To-dos ─────────────────────────────────────────────────────── */

function TodoSection({ projectPath, todos, onChange, sessions }: { projectPath: string; todos: Todo[]; onChange: (next: Todo[]) => void; sessions: SessionActions }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const open = todos.filter((t) => t.status === 'open');
  const closed = todos.filter((t) => t.status !== 'open');

  const add = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await workApi.createTodo(projectPath, text);
      onChange([created, ...todos]);
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const setStatus = async (todo: Todo, status: Todo['status']) => {
    const optimistic = todos.map((t) => (t.id === todo.id ? { ...t, status, closedAt: status === 'open' ? null : new Date().toISOString() } : t));
    onChange(optimistic);
    try {
      const updated = await workApi.updateTodo(todo.id, { status });
      onChange(optimistic.map((t) => (t.id === updated.id ? updated : t)));
    } catch (e) {
      setError((e as Error).message);
      onChange(todos);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void add();
    } else if (event.key === 'Escape') {
      setDraft('');
    }
  };

  return (
    <section>
      <SectionHeader title="My to-dos" count={open.length} />
      <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background px-2.5 focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30">
        {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Add a to-do and press Enter"
          enterKeyHint="done"
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
        />
      </div>
      {error && <p className="mt-1 px-1 text-xs text-destructive">{error}</p>}

      <ul className="mt-1.5 divide-y divide-border/50">
        {open.map((todo) => (
          <li key={todo.id} className="group flex items-start gap-2.5 px-1 py-1.5">
            <button
              type="button"
              title="Mark done"
              aria-label={`Mark "${todo.text}" done`}
              onClick={() => void setStatus(todo, 'done')}
              className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground/50 text-transparent transition-colors hover:border-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-600"
            >
              <Check className="h-3 w-3" strokeWidth={3} />
            </button>
            <div className="min-w-0 flex-1">
              <span className="whitespace-pre-wrap break-words text-sm">{todo.text}</span>
              <div className="mt-1 opacity-100 transition-opacity sm:opacity-60 sm:group-hover:opacity-100">
                <SessionButton seed={todoSeed(todo)} actions={sessions} />
              </div>
            </div>
            <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground/70">{timeAgo(todo.createdAt)}</span>
            <button
              type="button"
              title="Cancel"
              aria-label={`Cancel "${todo.text}"`}
              onClick={() => void setStatus(todo, 'cancelled')}
              className="shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-100 transition-opacity hover:bg-accent hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {open.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">Nothing on your list.</p>}

      {closed.length > 0 && (
        <div className="mt-1">
          <SectionHeader title="Closed today" count={closed.length} open={showClosed} onToggle={() => setShowClosed((v) => !v)} />
          {showClosed && (
            <ul className="divide-y divide-border/40">
              {closed.map((todo) => (
                <li key={todo.id} className="group flex items-start gap-2.5 px-1 py-1.5 text-muted-foreground">
                  {todo.status === 'done' ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <X className="mt-0.5 h-4 w-4 shrink-0" />}
                  <span className="min-w-0 flex-1 break-words text-sm line-through">{todo.text}</span>
                  <button
                    type="button"
                    title="Reopen"
                    onClick={() => void setStatus(todo, 'open')}
                    className="shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/* ── Jira ───────────────────────────────────────────────────────── */

type MovedTask = { task: JiraTask; from: string; to: string; at: number };

function JiraTaskRow({
  task,
  pullRequests,
  actions,
  pending,
  onMove,
  sessions,
}: {
  task: JiraTask;
  pullRequests: PullRequest[];
  actions: string[];
  pending: string | null;
  onMove: (task: JiraTask, to: string) => void;
  sessions: SessionActions;
}) {
  const hasPr = pullRequests.length > 0;
  const suggestPr = hasPr && PRE_REVIEW_STATUSES.has(task.status.toLowerCase());
  const available = actions.filter((a) => a.toLowerCase() !== task.status.toLowerCase());

  return (
    <li className="group px-1 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <a href={task.url} target="_blank" rel="noreferrer" className="group/link block min-w-0">
            <span className="mr-1.5 font-mono text-xs text-muted-foreground group-hover/link:text-primary">{task.key}</span>
            <span className="text-sm text-foreground group-hover/link:underline">{task.summary}</span>
          </a>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <SprintBadge task={task} />
            <StatusBadge status={task.status} />
            <span>{task.issueType}</span>
            {task.carriedOverSprints > 0 && (
              <span
                className={cn(task.carriedOverSprints >= 3 && 'text-amber-700 dark:text-amber-400')}
                title={`Already went through ${task.carriedOverSprints} closed sprint${task.carriedOverSprints > 1 ? 's' : ''}`}
              >
                · ↻ {task.carriedOverSprints} sprint{task.carriedOverSprints > 1 ? 's' : ''}
              </span>
            )}
            {task.priority && task.priority !== 'Medium' && <span>· {task.priority}</span>}
            <span>· {timeAgo(task.updated)}</span>
            {pullRequests.map((pr) => (
              <a
                key={`${pr.repo}-${pr.id}`}
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 rounded bg-violet-500/10 px-1.5 py-px text-violet-600 hover:bg-violet-500/20 dark:text-violet-400"
              >
                <GitPullRequest className="h-3 w-3" />
                {pr.repo.replace(/^golfn-/, '')} #{pr.id}
              </a>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1 opacity-100 transition-opacity sm:opacity-60 sm:group-hover:opacity-100">
        <SessionButton seed={jiraSeed(task)} actions={sessions} />
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
        {available.map((action) => {
          const isSuggested = suggestPr && action.toLowerCase() === 'pull request';
          const isCancel = action.toLowerCase().startsWith('cancel');
          return (
            <button
              key={action}
              type="button"
              disabled={Boolean(pending)}
              onClick={() => onMove(task, action)}
              title={isSuggested ? 'A pull request is open for this task' : `Move to ${action}`}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded border px-2 text-[11px] font-medium transition-colors disabled:opacity-50',
                isSuggested
                  ? 'border-violet-500/50 bg-violet-500/10 text-violet-700 hover:bg-violet-500/20 dark:text-violet-300'
                  : isCancel
                    ? 'border-border/70 text-muted-foreground hover:border-destructive/50 hover:text-destructive'
                    : 'border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {pending === action && <Loader2 className="h-3 w-3 animate-spin" />}
              {action}
            </button>
          );
        })}
      </div>
    </li>
  );
}

function JiraSection({
  projectPath,
  config,
  tasks,
  error,
  prsByKey,
  onTasksChange,
  sessions,
}: {
  projectPath: string;
  config: NonNullable<WorkConfig['jira']>;
  tasks: JiraTask[];
  error: string | null;
  prsByKey: Map<string, PullRequest[]>;
  onTasksChange: (next: JiraTask[]) => void;
  sessions: SessionActions;
}) {
  const [pending, setPending] = useState<Record<string, string>>({});
  const [moved, setMoved] = useState<MovedTask[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [sprintFilter, setSprintFilter] = useState<SprintFilter>(() => {
    try {
      const saved = localStorage.getItem('work:sprintFilter');
      return saved === 'sprint' || saved === 'backlog' ? saved : 'all';
    } catch {
      return 'all';
    }
  });
  const chooseFilter = (value: SprintFilter) => {
    setSprintFilter(value);
    try {
      localStorage.setItem('work:sprintFilter', value);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  };
  const inSprintCount = tasks.filter((t) => t.sprint?.state === 'active').length;
  const visibleTasks = tasks.filter((t) => (
    sprintFilter === 'all'
    || (sprintFilter === 'sprint' ? t.sprint?.state === 'active' : t.sprint?.state !== 'active')
  ));

  // Moved rows offer Undo for a few seconds, then drop off.
  useEffect(() => {
    if (moved.length === 0) return undefined;
    const timer = window.setInterval(() => {
      setMoved((list) => list.filter((m) => Date.now() - m.at < UNDO_WINDOW_MS));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [moved.length]);

  const listed = new Set(config.statuses.map((s) => s.toLowerCase()));

  const move = useCallback(async (task: JiraTask, to: string, isUndo = false) => {
    setPending((p) => ({ ...p, [task.key]: to }));
    setActionError(null);
    try {
      const result = await workApi.transition(projectPath, task.key, to);
      const updated = { ...task, status: result.to, updated: new Date().toISOString() };
      setMoved((list) => list.filter((m) => m.task.key !== task.key));
      if (listed.has(result.to.toLowerCase())) {
        onTasksChange([...tasks.filter((t) => t.key !== task.key), updated]);
      } else {
        onTasksChange(tasks.filter((t) => t.key !== task.key));
        if (!isUndo) setMoved((list) => [...list, { task: updated, from: result.from, to: result.to, at: Date.now() }]);
      }
    } catch (e) {
      setActionError(`${task.key}: ${(e as Error).message}`);
    } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[task.key];
        return next;
      });
    }
  }, [listed, onTasksChange, projectPath, tasks]);

  const undo = async (entry: MovedTask) => {
    setMoved((list) => list.filter((m) => m !== entry));
    await move(entry.task, entry.from, true);
  };

  const groups = config.statuses.map((status) => ({
    status,
    collapsedByDefault: config.collapsedStatuses.some((s) => s.toLowerCase() === status.toLowerCase()),
    // Current-sprint work first, then the next sprint, then backlog; newest first within each.
    tasks: visibleTasks
      .filter((t) => t.status.toLowerCase() === status.toLowerCase())
      .sort((a, b) => {
        const rank = (t: JiraTask) => (t.sprint?.state === 'active' ? 0 : t.sprint ? 1 : 2);
        return rank(a) - rank(b) || b.updated.localeCompare(a.updated);
      }),
  })).filter((g) => g.tasks.length > 0);

  return (
    <section>
      <SectionHeader
        title={`Jira · ${config.projectKey}`}
        count={tasks.length}
        right={(
          <div role="radiogroup" aria-label="Sprint filter" className="flex items-center rounded-md border border-border/60 p-px text-[11px]">
            {([
              ['all', `All ${tasks.length}`],
              ['sprint', `Sprint ${inSprintCount}`],
              ['backlog', `Backlog ${tasks.length - inSprintCount}`],
            ] as Array<[SprintFilter, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={sprintFilter === value}
                onClick={() => chooseFilter(value)}
                className={cn(
                  'rounded px-1.5 py-0.5 transition-colors',
                  sprintFilter === value ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      />
      {error && <SourceError label="Jira" error={error} />}
      {actionError && <p className="mb-1 px-1 text-xs text-destructive">{actionError}</p>}

      {moved.length > 0 && (
        <ul className="mb-2 space-y-1">
          {moved.map((entry) => (
            <li key={entry.task.key} className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-800 dark:text-emerald-300">
              <Check className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-mono">{entry.task.key}</span> moved to <strong>{entry.to}</strong>
              </span>
              <button type="button" onClick={() => void undo(entry)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-emerald-500/20">
                <Undo2 className="h-3 w-3" /> Undo
              </button>
            </li>
          ))}
        </ul>
      )}

      {groups.map((group) => {
        const isOpen = openGroups[group.status] ?? !group.collapsedByDefault;
        return (
          <div key={group.status} className="mb-2">
            <SectionHeader
              title={group.status}
              count={group.tasks.length}
              open={isOpen}
              onToggle={() => setOpenGroups((g) => ({ ...g, [group.status]: !isOpen }))}
            />
            {isOpen && (
              <ul className="divide-y divide-border/50">
                {group.tasks.map((task) => (
                  <JiraTaskRow
                    key={task.key}
                    task={task}
                    pullRequests={prsByKey.get(task.key) ?? []}
                    actions={config.actions}
                    pending={pending[task.key] ?? null}
                    onMove={(t, to) => void move(t, to)}
                    sessions={sessions}
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {!error && tasks.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">No open Jira tasks assigned to you.</p>}
      {!error && tasks.length > 0 && visibleTasks.length === 0 && (
        <p className="px-1 py-2 text-xs text-muted-foreground">{sprintFilter === 'sprint' ? 'Nothing of yours in the current sprint.' : 'Nothing in the backlog.'}</p>
      )}
    </section>
  );
}

/* ── Pull requests ──────────────────────────────────────────────── */

function PullRequestRow({ pr, jiraUrlFor }: { pr: PullRequest; jiraUrlFor: (key: string) => string | null }) {
  const age = ageInDays(pr.createdOn);
  const unusualTarget = !['develop', 'dev'].includes(pr.destinationBranch);
  return (
    <li className="px-1 py-2">
      <a href={pr.url} target="_blank" rel="noreferrer" className="group/link flex items-start gap-1.5">
        <GitPullRequest className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" />
        <span className="min-w-0 flex-1 text-sm group-hover/link:underline">
          {pr.draft && <span className="mr-1 text-muted-foreground">[draft]</span>}
          {pr.title}
        </span>
        <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover/link:opacity-100" />
      </a>
      <div className="ml-5 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/80">{pr.repo} #{pr.id}</span>
        <span className="inline-flex min-w-0 items-center gap-1 font-mono">
          <span className="max-w-[16rem] truncate" title={pr.sourceBranch}>{pr.sourceBranch}</span>
          <span>→</span>
          <span className={cn(unusualTarget && 'rounded bg-amber-500/15 px-1 text-amber-700 dark:text-amber-400')} title={unusualTarget ? 'Not targeting develop' : undefined}>
            {pr.destinationBranch}
          </span>
        </span>
        {pr.issueKeys.map((key) => {
          const url = jiraUrlFor(key);
          return url ? (
            <a key={key} href={url} target="_blank" rel="noreferrer" className="font-mono hover:text-primary hover:underline">{key}</a>
          ) : (
            <span key={key} className="font-mono">{key}</span>
          );
        })}
        {!pr.isMine && <span>by {pr.author}</span>}
        <span className={cn(age >= 7 && 'text-amber-700 dark:text-amber-400')}>{age === 0 ? 'today' : `${age}d old`}</span>
        {pr.reviewers.length > 0 && <span>{pr.approvals}/{pr.reviewers.length} approved</span>}
        {pr.commentCount > 0 && (
          <span className="inline-flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{pr.commentCount}</span>
        )}
        {pr.taskCount > 0 && <span>{pr.taskCount} open tasks</span>}
      </div>
    </li>
  );
}

function PullRequestSection({ prs, error, jiraUrlFor }: { prs: PullRequest[]; error: string | null; jiraUrlFor: (key: string) => string | null }) {
  const [showTeam, setShowTeam] = useState(false);
  const mine = prs.filter((p) => p.isMine);
  const team = prs.filter((p) => !p.isMine);
  return (
    <section>
      <SectionHeader title="My pull requests" count={mine.length} />
      {error && <SourceError label="Bitbucket" error={error} />}
      <ul className="divide-y divide-border/50">
        {mine.map((pr) => <PullRequestRow key={`${pr.repo}-${pr.id}`} pr={pr} jiraUrlFor={jiraUrlFor} />)}
      </ul>
      {!error && mine.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">No open pull requests.</p>}

      {team.length > 0 && (
        <div className="mt-3">
          <SectionHeader title="Team pull requests" count={team.length} open={showTeam} onToggle={() => setShowTeam((v) => !v)} />
          {showTeam && (
            <ul className="divide-y divide-border/50">
              {team.map((pr) => <PullRequestRow key={`${pr.repo}-${pr.id}`} pr={pr} jiraUrlFor={jiraUrlFor} />)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/* ── Panel ──────────────────────────────────────────────────────── */

/** The project's Work tab: personal to-dos, Jira tasks with status buttons, and open pull requests. */
export default function WorkPanel({ project, config, isVisible, onOpenSession, onStartNewSession }: WorkPanelProps) {
  const projectPath = project.fullPath || project.path || '';
  const [items, setItems] = useState<WorkItems | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [, forceTick] = useState(0);

  const load = useCallback(async (refresh = false) => {
    if (!projectPath) return;
    setLoading(true);
    try {
      const next = await workApi.items(projectPath, refresh);
      setItems(next);
      setError(null);
      setLoadedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    setItems(null);
  }, [projectPath]);

  // Deleting or archiving a session in the sidebar changes the project's
  // session list; reload so its link disappears right away. Cheap: Jira and
  // Bitbucket answers come from the server's one-minute cache.
  const sessionSignature = (project.sessions ?? []).map((s) => s.id).join(',');
  const lastSignatureRef = useRef(sessionSignature);
  useEffect(() => {
    if (lastSignatureRef.current === sessionSignature) return;
    lastSignatureRef.current = sessionSignature;
    if (isVisible) void load();
  }, [isVisible, load, sessionSignature]);

  // Load when shown, refresh in the background while visible, and when the window regains focus.
  useEffect(() => {
    if (!isVisible) return undefined;
    void load();
    const interval = window.setInterval(() => void load(), AUTO_REFRESH_MS);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    const ticker = window.setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(ticker);
      window.removeEventListener('focus', onFocus);
    };
  }, [isVisible, load]);

  const prs = useMemo(() => items?.pullRequests?.items ?? [], [items]);
  const tasks = useMemo(() => items?.jira?.items ?? [], [items]);

  const prsByKey = useMemo(() => {
    const map = new Map<string, PullRequest[]>();
    for (const pr of prs) {
      for (const key of pr.issueKeys) map.set(key, [...(map.get(key) ?? []), pr]);
    }
    return map;
  }, [prs]);

  const sessions = useMemo<SessionActions>(() => {
    const links = items?.links ?? [];
    return {
      linksFor: (itemType, itemKey) => links.filter((l) => l.itemType === itemType && l.itemKey === itemKey),
      open: onOpenSession,
      start: (seed) => {
        // Prefill the new chat's composer, remember which item it is for, then open a new chat.
        writeDraftText(`project:${project.projectId}`, seed.prompt);
        setPendingWorkLink({
          projectPath,
          itemType: seed.itemType,
          itemKey: seed.itemKey,
          sessionName: seed.sessionName,
          matchPrefix: seed.prompt.trim().split(/\s+/).slice(0, 3).join(' '),
        });
        onStartNewSession();
      },
      unlink: (link) => {
        setItems((cur) => (cur ? { ...cur, links: cur.links.filter((l) => l !== link) } : cur));
        void workApi.unlink(projectPath, link.itemType, link.itemKey, link.sessionId).catch(() => void load());
      },
    };
  }, [items?.links, load, onOpenSession, onStartNewSession, project.projectId, projectPath]);

  const jiraSite = tasks[0]?.url.replace(/\/browse\/.*$/, '') ?? null;
  const jiraUrlFor = useCallback((key: string) => {
    if (!jiraSite || !config.jira || !key.startsWith(`${config.jira.projectKey}-`)) return null;
    return `${jiraSite}/browse/${key}`;
  }, [config.jira, jiraSite]);

  if (!isVisible) return null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
        <h2 className="text-sm font-semibold">{config.name ?? project.displayName} · Work</h2>
        <span className="text-xs text-muted-foreground">{loadedAt ? `updated ${timeAgo(new Date(loadedAt).toISOString())}` : ''}</span>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && !items && (
          <div className="p-4"><SourceError label="Work" error={error} /></div>
        )}
        {!items && !error && (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        {items && (
          <div className="mx-auto grid max-w-6xl gap-6 p-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-5">
              {items.todos && (
                <TodoSection
                  projectPath={projectPath}
                  todos={items.todos}
                  onChange={(todos) => setItems((cur) => (cur ? { ...cur, todos } : cur))}
                  sessions={sessions}
                />
              )}
              {config.jira && items.jira && (
                <JiraSection
                  projectPath={projectPath}
                  config={config.jira}
                  tasks={tasks}
                  error={items.jira.error}
                  prsByKey={prsByKey}
                  onTasksChange={(next) => setItems((cur) => (cur && cur.jira ? { ...cur, jira: { ...cur.jira, items: next } } : cur))}
                  sessions={sessions}
                />
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              {config.slack && items.slack && (
                <SlackSection
                  projectPath={projectPath}
                  mentions={items.slack.items}
                  resolved={items.slackResolved ?? []}
                  error={items.slack.error}
                  sessions={sessions}
                  onChange={(next) => setItems((cur) => (cur && cur.slack
                    ? { ...cur, slack: { ...cur.slack, items: next.mentions }, slackResolved: next.resolved }
                    : cur))}
                />
              )}
              {config.bitbucket && items.pullRequests && (
                <PullRequestSection prs={prs} error={items.pullRequests.error} jiraUrlFor={jiraUrlFor} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
