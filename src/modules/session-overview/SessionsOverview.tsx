import { GitPullRequest, Hash, Loader2, MessageSquare, Plus, Search, Ticket, X, ListTodo } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { statusDotClass } from '@/modules/work';
import type { Project } from '@/shared/types';

import { fetchSessionCards, modelLabel, type SessionCard, type SessionWorkItem } from '@/modules/session-overview/api';

type Props = {
  project: Project | null;
  isVisible: boolean;
  onOpenSession: (sessionId: string) => void;
  onStartNewSession: () => void;
};

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso.replace(' ', 'T') + (iso.includes('T') || iso.endsWith('Z') ? '' : 'Z')).getTime();
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Wraps every searched word in <mark>. */
function highlight(text: string, words: string[]): ReactNode {
  if (!words.length) return text;
  const pattern = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(pattern).map((part, index) => (index % 2 === 1
    ? <mark key={index} className="rounded bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-500/40">{part}</mark>
    : <Fragment key={index}>{part}</Fragment>));
}

const ITEM_ICONS = { jira: Ticket, slack: Hash, pr: GitPullRequest, todo: ListTodo } as const;

function WorkChip({ item }: { item: SessionWorkItem }) {
  const Icon = ITEM_ICONS[item.type];
  const dot = item.type === 'jira'
    ? statusDotClass(item.status)
    : item.type === 'slack'
      ? (item.status === 'waiting' ? 'bg-amber-500' : 'bg-emerald-500')
      : item.type === 'pr'
        ? (item.status === 'open' ? 'bg-sky-500' : 'bg-muted-foreground/50')
        : null;
  return (
    <span
      title={`${item.label}${item.title ? ` · ${item.title}` : ''}${item.status ? ` (${item.status})` : ''}`}
      className="inline-flex max-w-44 items-center gap-1 rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground"
    >
      {dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />}
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{item.type === 'jira' || item.type === 'pr' ? item.label : item.title || item.label}</span>
    </span>
  );
}

function WorkChips({ items }: { items: SessionWorkItem[] }) {
  const closedPrs = items.filter((i) => i.type === 'pr' && i.status !== 'open');
  const shown = items.filter((i) => !(i.type === 'pr' && i.status !== 'open'));
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.slice(0, 4).map((item) => <WorkChip key={`${item.type}:${item.key}`} item={item} />)}
      {shown.length > 4 && <span className="px-1 text-[11px] text-muted-foreground">+{shown.length - 4}</span>}
      {closedPrs.length > 0 && (
        <span className="inline-flex items-center gap-1 px-1 text-[11px] text-muted-foreground/80" title={closedPrs.map((p) => p.label).join(', ')}>
          <GitPullRequest className="h-3 w-3" />+{closedPrs.length} PR{closedPrs.length > 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
}

const MATCH_LABEL = { title: 'title / linked item', user: 'your message', assistant: "Claude's reply" } as const;

function Card({ card, words, onOpen }: { card: SessionCard; words: string[]; onOpen: () => void }) {
  const model = modelLabel(card.model);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full min-w-0 flex-col gap-2 rounded-xl border border-border bg-card p-3 text-left shadow-sm transition hover:border-primary/50 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        {model && <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">{model}</span>}
        {card.provider !== 'claude' && <span className="rounded bg-muted px-1.5 py-0.5">{card.provider}</span>}
        <span className="inline-flex items-center gap-0.5" title={`${card.userTurns} messages from you`}>
          <MessageSquare className="h-3 w-3" />{card.userTurns}
        </span>
        <span className="ml-auto shrink-0" title={new Date(card.lastActivity).toLocaleString()}>{timeAgo(card.lastActivity)}</span>
      </div>

      <div className="min-w-0">
        <div className="line-clamp-2 text-sm font-semibold leading-snug text-foreground group-hover:text-primary">
          {highlight(card.title, words)}
        </div>
        {card.topic && card.topic !== card.title && (
          <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{card.topic}</div>
        )}
      </div>

      <WorkChips items={card.workItems} />

      {card.match && card.match.in !== 'title' ? (
        <div className="rounded-md border border-yellow-300/60 bg-yellow-50 p-2 text-xs leading-relaxed text-foreground/90 dark:border-yellow-500/30 dark:bg-yellow-500/10">
          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Found in {MATCH_LABEL[card.match.in]}</div>
          <div className="line-clamp-4">{highlight(card.match.snippet, words)}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-col gap-1.5 text-xs leading-relaxed">
          {card.lastUser && (
            <div className="line-clamp-2 text-foreground/85">
              <span className="font-medium text-muted-foreground">You: </span>{card.lastUser.text}
            </div>
          )}
          {card.lastAssistant && (
            <div className="line-clamp-3 text-muted-foreground">
              <span className="font-medium">Claude: </span>{card.lastAssistant.text}
            </div>
          )}
          {!card.lastUser && !card.lastAssistant && <div className="italic text-muted-foreground/70">No messages yet</div>}
        </div>
      )}
    </button>
  );
}

function SkeletonCard() {
  return (
    <div className="flex h-44 animate-pulse flex-col gap-2 rounded-xl border border-border bg-card p-3">
      <div className="h-3 w-1/3 rounded bg-muted" />
      <div className="h-4 w-4/5 rounded bg-muted" />
      <div className="h-3 w-2/5 rounded bg-muted" />
      <div className="mt-auto h-10 rounded bg-muted" />
    </div>
  );
}

/**
 * Kvn: the project's recent sessions as cards (title, last exchange, model,
 * linked Jira / Slack / PRs), with a search through everything said in them.
 */
export default function SessionsOverview({ project, isVisible, onOpenSession, onStartNewSession }: Props) {
  const projectId = project?.projectId ?? null;
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [cards, setCards] = useState<SessionCard[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!projectId || !isVisible) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchSessionCards(projectId, debounced, controller.signal)
      .then((data) => {
        setCards(data.cards);
        setTotal(data.total);
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, debounced, isVisible]);

  useEffect(() => {
    if (!isVisible) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isVisible]);

  const words = useMemo(() => debounced.toLowerCase().split(/\s+/).filter(Boolean), [debounced]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
              if (e.key === 'Enter' && cards?.length) onOpenSession(cards[0].id);
            }}
            placeholder="Find a session by anything said in it…  ( / )"
            className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-8 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Clear search">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {cards && (words.length ? `${cards.length} match${cards.length === 1 ? '' : 'es'}` : `${cards.length} of ${total} sessions`)}
        </span>
        <button
          type="button"
          onClick={onStartNewSession}
          className="inline-flex h-9 items-center gap-1 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> New session
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        {!cards && !error && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => <SkeletonCard key={i} />)}
          </div>
        )}
        {cards && cards.length === 0 && !loading && (
          <div className="py-16 text-center text-sm text-muted-foreground">
            {words.length ? `No session mentions “${debounced}”.` : 'No sessions in this project yet.'}
          </div>
        )}
        {cards && cards.length > 0 && (
          <div className={`grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 ${loading ? 'opacity-70' : ''}`}>
            {cards.map((card) => <Card key={card.id} card={card} words={words} onOpen={() => onOpenSession(card.id)} />)}
          </div>
        )}
      </div>
    </div>
  );
}
