import { MessagesSquare, Play, Plus, X } from 'lucide-react';

import { cn } from '@/shared/utils';
import type { JiraTask, Todo, WorkLink } from '@/modules/work/api';

/** What a row needs to show and start its linked sessions. */
export type SessionActions = {
  linksFor: (itemType: WorkLink['itemType'], itemKey: string) => WorkLink[];
  start: (item: SessionSeed) => void;
  open: (sessionId: string) => void;
  unlink: (link: WorkLink) => void;
};

export type SessionSeed = {
  itemType: WorkLink['itemType'];
  itemKey: string;
  /** Session title, e.g. "jira: GOL-3581 Cashback ledger line". */
  sessionName: string;
  /** Text prefilled in the new chat's composer. */
  prompt: string;
  /** Button label when no session is linked yet. Default "Start session". */
  label?: string;
  /** Runs when a new session is started from this item (e.g. move the Jira task to In Progress). */
  onStart?: () => void;
};

const MAX_SESSION_NAME = 80;

export function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1).trimEnd()}…` : single;
}

export function jiraSeed(task: JiraTask): SessionSeed {
  const lines = [
    `jira: ${task.key} ${task.summary}`,
    task.url,
    `Status: ${task.status}${task.sprint ? ` · ${task.sprint.name}` : ' · Backlog'}`,
    '',
    `Read ${task.key} and its comments first (Atlassian connector). If it needs code changes, create a worktree for it with golfn:worktree (branch named after ${task.key}), then give me a short plan before changing anything. If it is a data or config request, just tell me what you would run.`,
    '',
  ];
  return {
    itemType: 'jira',
    itemKey: task.key,
    sessionName: clip(`jira: ${task.key} ${task.summary}`, MAX_SESSION_NAME),
    prompt: lines.join('\n'),
    label: 'Start work',
  };
}

export function todoSeed(todo: Todo): SessionSeed {
  return {
    itemType: 'todo',
    itemKey: String(todo.id),
    sessionName: clip(`todo: ${todo.text}`, MAX_SESSION_NAME),
    prompt: `todo: ${todo.text}\n\n`,
  };
}

/** The per-row session control: open the linked session, or start a new one prefilled with the item. */
export function SessionButton({ seed, actions }: { seed: SessionSeed; actions: SessionActions }) {
  const links = actions.linksFor(seed.itemType, seed.itemKey);
  const latest = links[0];
  const buttonClass = 'inline-flex h-6 items-center gap-1 rounded border px-2 text-[11px] font-medium transition-colors';
  if (!latest) {
    return (
      <button
        type="button"
        onClick={() => {
          seed.onStart?.();
          actions.start(seed);
        }}
        title="Start a new session with this item's details"
        className={cn(buttonClass, 'border-border/70 text-muted-foreground hover:border-primary/50 hover:bg-primary/5 hover:text-primary')}
      >
        <Play className="h-3 w-3" /> {seed.label ?? 'Start session'}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => actions.open(latest.sessionId)}
        title={latest.sessionName ? `Open "${latest.sessionName}"` : 'Open the linked session'}
        className={cn(buttonClass, 'max-w-[14rem] border-primary/40 bg-primary/10 text-primary hover:bg-primary/15')}
      >
        <MessagesSquare className="h-3 w-3 shrink-0" />
        <span className="truncate">Open session{links.length > 1 ? ` (${links.length})` : ''}</span>
      </button>
      <button
        type="button"
        onClick={() => actions.start(seed)}
        title="Start another session for this item"
        aria-label="Start another session"
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Plus className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={() => actions.unlink(latest)}
        title="Unlink this session"
        aria-label="Unlink session"
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

