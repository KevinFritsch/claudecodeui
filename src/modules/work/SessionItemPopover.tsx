import { ArrowRight, Check, ExternalLink, Link2Off, Loader2, Undo2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/shared/utils';
import { workApi, type SessionLinkView, type SlackMention, type TodoStatus } from '@/modules/work/api';
import { SprintBadge, StatusBadge } from '@/modules/work/JiraBadges';
import { ConversationRow, groupConversations, type Conversation, type SlackClosedHow } from '@/modules/work/SlackSection';

/**
 * Kvn: quick actions for the Work item a session is attached to, opened from
 * its chip in the session bar: move the Jira task (QA, QA App, Done…), or
 * answer the Slack message (Done, react, Reply, AI reply), without going back
 * to the Work tab.
 */

/** The usual path of a task; the step after the current one is offered first. */
const JIRA_FLOW = ['to do', 'in progress', 'pull request', 'qa', 'qa app', 'done'];

function nextStep(status: string | null, actions: string[]): string | null {
  const index = status ? JIRA_FLOW.indexOf(status.toLowerCase()) : -1;
  if (index < 0) return null;
  for (const step of JIRA_FLOW.slice(index + 1)) {
    const action = actions.find((a) => a.toLowerCase() === step);
    if (action) return action;
  }
  return null;
}

function Shell({
  anchor,
  width,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  width: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const isPhone = typeof window !== 'undefined' && window.innerWidth < 640;
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (isPhone) return undefined;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const boxWidth = Math.min(width, window.innerWidth - 16);
      const left = Math.min(Math.max(8, rect.right - boxWidth), window.innerWidth - boxWidth - 8);
      const top = rect.bottom + 6;
      setPosition({ top, left, maxHeight: Math.max(200, window.innerHeight - top - 12) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, isPhone, width]);

  useEffect(() => {
    const onDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as HTMLElement;
      if (boxRef.current?.contains(target) || anchor.contains(target)) return;
      // The emoji picker is a separate floating layer opened from inside this one.
      if (target.closest?.('[role="dialog"]')) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Escape inside the reply box closes the box first (handled there).
      if ((event.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <>
      {isPhone && <div className="fixed inset-0 z-50 bg-black/40" aria-hidden />}
      <div
        ref={boxRef}
        data-escape-layer
        style={isPhone ? undefined : {
          top: position?.top ?? -9999,
          left: position?.left ?? -9999,
          width: Math.min(width, window.innerWidth - 16),
          maxHeight: position?.maxHeight,
        }}
        className={cn(
          'fixed z-50 overflow-y-auto border border-border bg-popover text-popover-foreground shadow-xl',
          isPhone ? 'inset-x-0 bottom-0 max-h-[80vh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]' : 'rounded-xl',
        )}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

function Footer({ link, onDetach, onClose }: { link: SessionLinkView; onDetach: () => void; onClose: () => void }) {
  return (
    <div className="flex items-center gap-1 border-t border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground">
      {link.url && (
        <a href={link.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent hover:text-foreground">
          <ExternalLink className="h-3 w-3" /> Open in {link.itemType === 'jira' ? 'Jira' : link.itemType === 'slack' ? 'Slack' : 'Bitbucket'}
        </a>
      )}
      {!link.derived && (
        <button type="button" onClick={onDetach} className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent hover:text-foreground" title="Detach it from this session (the item itself is not changed)">
          <Link2Off className="h-3 w-3" /> Detach
        </button>
      )}
      <button type="button" onClick={onClose} className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent hover:text-foreground">
        <X className="h-3 w-3" /> Close
      </button>
    </div>
  );
}

function JiraPanel({
  link,
  projectPath,
  actions,
  onChanged,
}: {
  link: SessionLinkView;
  projectPath: string;
  actions: string[];
  onChanged: () => void;
}) {
  const task = link.jira ?? null;
  const [status, setStatus] = useState<string | null>(task?.status ?? link.status);
  const [pending, setPending] = useState<string | null>(null);
  const [moved, setMoved] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const suggested = nextStep(status, actions);
  const available = actions.filter((action) => action.toLowerCase() !== (status ?? '').toLowerCase());

  const move = async (to: string, isUndo = false) => {
    setPending(to);
    setError(null);
    try {
      const result = await workApi.transition(projectPath, link.itemKey, to);
      setStatus(result.to);
      setMoved(isUndo ? null : { from: result.from, to: result.to });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[11px] text-muted-foreground">{link.itemKey}</div>
          <div className="text-sm font-medium leading-snug text-foreground">{task?.summary ?? link.title}</div>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        {status ? <StatusBadge status={status} /> : <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide">Not on your board</span>}
        {task && <SprintBadge task={task} />}
        {task && <span>{task.issueType}</span>}
        {task?.priority && task.priority !== 'Medium' && <span>· {task.priority}</span>}
      </div>

      <div className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Move to</div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {available.map((action) => {
          const isSuggested = action === suggested;
          const isCancel = action.toLowerCase().startsWith('cancel');
          return (
            <button
              key={action}
              type="button"
              disabled={pending !== null}
              onClick={() => void move(action)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:opacity-50',
                isSuggested
                  ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
                  : isCancel
                    ? 'border-border/70 text-muted-foreground hover:border-destructive/50 hover:text-destructive'
                    : 'border-border/70 text-foreground/90 hover:bg-accent',
              )}
              title={isSuggested ? 'The usual next step' : `Move ${link.itemKey} to ${action}`}
            >
              {pending === action ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : isSuggested ? <ArrowRight className="h-3.5 w-3.5" /> : null}
              {action}
            </button>
          );
        })}
      </div>

      {moved && (
        <div className="mt-2.5 flex items-center gap-2 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-800 dark:text-emerald-300">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{link.itemKey} moved to {moved.to}</span>
          <button type="button" disabled={pending !== null} onClick={() => void move(moved.from, true)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-emerald-500/20">
            <Undo2 className="h-3 w-3" /> Undo
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function SlackPanel({ link, projectPath, onChanged }: { link: SessionLinkView; projectPath: string; onChanged: () => void }) {
  const [messages, setMessages] = useState<SlackMention[]>(link.slack?.messages ?? []);
  const [closed, setClosed] = useState<{ conversation: Conversation; how: SlackClosedHow; emoji?: string | null; name?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const conversation = useMemo(
    () => groupConversations(messages).find((group) => group.messages.some((m) => m.id === link.itemKey)) ?? null,
    [link.itemKey, messages],
  );

  if (!conversation) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        This message is no longer in your Slack list (answered, or older than the list goes back).
      </div>
    );
  }

  const undo = async () => {
    if (!closed) return;
    const { latest, messages: all } = closed.conversation;
    setError(null);
    try {
      if (closed.how === 'resolved') await workApi.resolve(projectPath, 'slack', all.map((m) => m.id), false);
      else await workApi.slackDone(projectPath, latest.id, false, closed.name, all.filter((m) => m.id !== latest.id).map((m) => m.id));
      setClosed(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="px-2 pt-1">
      {!link.slack?.waiting && !closed && (
        <div className="mx-1 mt-2 inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-800 dark:text-emerald-300">
          <Check className="h-3 w-3" /> Already answered or resolved; you can still reply
        </div>
      )}
      {closed && (
        <div className="mx-1 mt-2 flex items-center gap-2 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-800 dark:text-emerald-300">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {closed.how === 'done' ? `${closed.emoji ?? '✅'} added in Slack` : closed.how === 'resolved' ? 'Resolved (hidden from your list)' : 'Reply sent'}
          </span>
          {closed.how !== 'replied' && (
            <button type="button" onClick={() => void undo()} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-emerald-500/20">
              <Undo2 className="h-3 w-3" /> Undo
            </button>
          )}
        </div>
      )}
      {error && <p className="mx-1 mt-1 text-xs text-destructive">{error}</p>}
      <ul>
        <ConversationRow
          conversation={conversation}
          isNew={false}
          projectPath={projectPath}
          onClosed={(done, how, reaction) => {
            setClosed({ conversation: done, how, emoji: reaction?.char, name: reaction?.name });
            onChanged();
          }}
          onReacted={(message) => setMessages((list) => list.map((m) => (m.id === message.id ? message : m)))}
        />
      </ul>
    </div>
  );
}

function TodoPanel({ link, onChanged }: { link: SessionLinkView; onChanged: () => void }) {
  const [status, setStatus] = useState<string | null>(link.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = async (next: TodoStatus) => {
    setBusy(true);
    setError(null);
    try {
      await workApi.updateTodo(Number(link.itemKey), { status: next });
      setStatus(next);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const button = 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 px-2.5 text-xs font-medium hover:bg-accent disabled:opacity-50';
  return (
    <div className="p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">To-do · {status ?? 'deleted'}</div>
      <div className="mt-0.5 whitespace-pre-wrap break-words text-sm">{link.title}</div>
      {status && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {status === 'open' ? (
            <>
              <button type="button" disabled={busy} onClick={() => void set('done')} className={cn(button, 'border-primary bg-primary text-primary-foreground hover:bg-primary/90')}>
                <Check className="h-3.5 w-3.5" /> Mark done
              </button>
              <button type="button" disabled={busy} onClick={() => void set('cancelled')} className={cn(button, 'text-muted-foreground')}>Cancel it</button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => void set('open')} className={button}>
              <Undo2 className="h-3.5 w-3.5" /> Reopen
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

export default function SessionItemPopover({
  link,
  anchor,
  projectPath,
  jiraActions,
  onChanged,
  onDetach,
  onClose,
}: {
  link: SessionLinkView;
  anchor: HTMLElement;
  projectPath: string;
  jiraActions: string[];
  /** Something changed (status, answered…): reload the session's chips. */
  onChanged: () => void;
  onDetach: () => void;
  onClose: () => void;
}) {
  return (
    <Shell anchor={anchor} width={link.itemType === 'slack' ? 460 : 380} onClose={onClose}>
      {link.itemType === 'jira' && <JiraPanel link={link} projectPath={projectPath} actions={jiraActions} onChanged={onChanged} />}
      {link.itemType === 'slack' && <SlackPanel link={link} projectPath={projectPath} onChanged={onChanged} />}
      {link.itemType === 'todo' && <TodoPanel link={link} onChanged={onChanged} />}
      <Footer link={link} onDetach={onDetach} onClose={onClose} />
    </Shell>
  );
}
