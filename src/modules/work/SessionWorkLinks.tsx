import { GitPullRequest, Hash, ListTodo, Loader2, MessageSquare, Plus, Search, Ticket, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/shared/utils';
import { workApi, type SessionLinkView, type WorkItems, type WorkLink } from '@/modules/work/api';
import SessionItemPopover from '@/modules/work/SessionItemPopover';
import { statusDotClass } from '@/modules/work/JiraBadges';
import { useWorkConfig } from '@/modules/work/useWorkConfig';

export const WORK_LINKS_CHANGED_EVENT = 'work:links-changed';

const ICONS: Record<WorkLink['itemType'], typeof Ticket> = {
  jira: Ticket,
  pr: GitPullRequest,
  todo: ListTodo,
  slack: MessageSquare,
};

type Candidate = { itemType: WorkLink['itemType']; itemKey: string; label: string; title: string };

function candidatesFrom(items: WorkItems, listedStatuses: string[]): Candidate[] {
  const listed = new Set(listedStatuses.map((s) => s.toLowerCase()));
  return [
    ...(items.jira?.items ?? []).filter((t) => listed.has(t.status.toLowerCase()))
      .map((t) => ({ itemType: 'jira' as const, itemKey: t.key, label: t.key, title: t.summary })),
    ...(items.todos ?? []).filter((t) => t.status === 'open')
      .map((t) => ({ itemType: 'todo' as const, itemKey: String(t.id), label: 'to-do', title: t.text })),
    ...(items.slack?.items ?? []).map((m) => ({ itemType: 'slack' as const, itemKey: m.id, label: `@${m.author}`, title: m.text })),
  ];
}

/**
 * Kvn: the Work items a session is attached to (Jira task, PR, to-do, Slack
 * message), as chips in the session bar, plus a + to attach more. Renders
 * nothing for projects without a Work setup.
 */
export default function SessionWorkLinks({ projectPath, sessionId, compact = false }: { projectPath: string; sessionId: string; compact?: boolean }) {
  const { config } = useWorkConfig(projectPath);
  const [links, setLinks] = useState<SessionLinkView[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [filter, setFilter] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // The chip whose quick actions are open (Jira moves, Slack reply…).
  const [openItem, setOpenItem] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    if (!config) return;
    workApi.sessionLinks(projectPath, sessionId).then((data) => setLinks(data.links)).catch(() => undefined);
  }, [config, projectPath, sessionId]);

  useEffect(() => {
    setLinks([]);
    setOpenItem(null);
    load();
    const onChange = () => load();
    window.addEventListener(WORK_LINKS_CHANGED_EVENT, onChange);
    const timer = window.setInterval(load, 120_000);
    return () => {
      window.removeEventListener(WORK_LINKS_CHANGED_EVENT, onChange);
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    setFilter('');
    setCandidates(null);
    workApi.items(projectPath).then((items) => setCandidates(candidatesFrom(items, config?.jira?.statuses ?? []))).catch(() => setCandidates([]));
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setPickerOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [config?.jira?.statuses, pickerOpen, projectPath]);

  const linkedIds = useMemo(() => new Set(links.map((l) => `${l.itemType}:${l.itemKey}`)), [links]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (candidates ?? [])
      .filter((c) => !linkedIds.has(`${c.itemType}:${c.itemKey}`))
      .filter((c) => !needle || `${c.label} ${c.title}`.toLowerCase().includes(needle))
      .slice(0, 40);
  }, [candidates, filter, linkedIds]);

  if (!config) return null;

  const attach = async (candidate: Candidate) => {
    setBusyKey(`${candidate.itemType}:${candidate.itemKey}`);
    try {
      await workApi.link(projectPath, candidate.itemType, candidate.itemKey, sessionId);
      window.dispatchEvent(new Event(WORK_LINKS_CHANGED_EVENT));
      setPickerOpen(false);
    } finally {
      setBusyKey(null);
    }
  };

  const detach = async (link: SessionLinkView) => {
    setLinks((list) => list.filter((l) => l !== link));
    await workApi.unlink(projectPath, link.itemType, link.itemKey, sessionId).catch(() => undefined);
    window.dispatchEvent(new Event(WORK_LINKS_CHANGED_EVENT));
  };

  const openLink = openItem ? links.find((l) => `${l.itemType}:${l.itemKey}` === openItem.id) ?? null : null;
  const maxChips = compact ? 1 : 3;
  const visible = links.slice(0, maxChips);
  const hidden = links.length - visible.length;

  return (
    <div ref={boxRef} className="relative flex min-w-0 flex-shrink items-center gap-1">
      {visible.map((link) => {
        const Icon = ICONS[link.itemType] ?? Hash;
        const id = `${link.itemType}:${link.itemKey}`;
        const hasActions = link.itemType !== 'pr';
        const isOpen = openItem?.id === id;
        const dot = link.itemType === 'jira'
          ? statusDotClass(link.status)
          : link.itemType === 'slack'
            ? (link.status === 'waiting' ? 'bg-amber-500' : 'bg-emerald-500')
            : link.itemType === 'todo'
              ? (link.status === 'open' ? 'bg-amber-500' : 'bg-emerald-500')
              : null;
        const chip = (
          <>
            <Icon className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{link.label}</span>
            {link.itemType === 'jira' && link.status && !compact && (
              <span className="hidden flex-shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground lg:inline">{link.status}</span>
            )}
            {dot && <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', dot)} aria-hidden />}
          </>
        );
        const hint = link.itemType === 'jira'
          ? `${link.title}${link.status ? ` · ${link.status}` : ''}\nClick to move it (QA, Done…)`
          : link.itemType === 'slack'
            ? `${link.title}\nClick to mark done, react or reply`
            : `${link.title}${link.derived ? ' (from the linked Jira task)' : ''}`;
        return (
          <span
            key={id}
            className={cn(
              'group/chip inline-flex h-5 max-w-[13rem] items-center gap-1 rounded border px-1.5 text-[11px] transition-colors',
              link.derived ? 'border-dashed border-border text-muted-foreground' : 'border-border/80 bg-muted/40 text-foreground/90',
              hasActions && 'hover:border-primary/50 hover:bg-accent',
              isOpen && 'border-primary/60 bg-accent',
              link.status === 'closed' && 'opacity-60',
            )}
            title={hint}
          >
            {hasActions ? (
              <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                onClick={(event) => setOpenItem(isOpen ? null : { id, anchor: event.currentTarget.parentElement ?? event.currentTarget })}
                className="inline-flex min-w-0 items-center gap-1"
              >
                {chip}
              </button>
            ) : link.url ? (
              <a href={link.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:text-primary">{chip}</a>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1">{chip}</span>
            )}
            {!link.derived && !hasActions && (
              <button
                type="button"
                onClick={() => void detach(link)}
                aria-label={`Detach ${link.label}`}
                className="-mr-0.5 hidden rounded text-muted-foreground hover:text-foreground group-hover/chip:inline-flex"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        );
      })}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="h-5 rounded px-1 text-[11px] text-muted-foreground hover:bg-accent"
          title={links.slice(maxChips).map((l) => `${l.label}: ${l.title}`).join('\n')}
        >
          +{hidden}
        </button>
      )}
      <button
        type="button"
        onClick={() => setPickerOpen((v) => !v)}
        aria-label="Attach a Work item to this session"
        title="Attach a Jira task, to-do or Slack message (PRs attach when the session creates them)"
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Plus className="h-3 w-3" />
      </button>

      {openLink && openItem && (
        <SessionItemPopover
          key={openItem.id}
          link={openLink}
          anchor={openItem.anchor}
          projectPath={projectPath}
          jiraActions={config.jira?.actions ?? []}
          onChanged={load}
          onDetach={() => {
            setOpenItem(null);
            void detach(openLink);
          }}
          onClose={() => setOpenItem(null)}
        />
      )}

      {pickerOpen && (
        <div className="absolute left-0 top-6 z-50 w-80 max-w-[85vw] rounded-md border border-border bg-popover p-1.5 shadow-lg">
          {links.length > 0 && (
            <div className="mb-1.5 border-b border-border/60 pb-1.5">
              <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Attached</div>
              {links.map((link) => {
                const Icon = ICONS[link.itemType] ?? Hash;
                return (
                  <div key={`${link.itemType}:${link.itemKey}`} className="flex items-center gap-1.5 rounded px-1 py-1 text-xs">
                    <Icon className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                    {link.url ? (
                      <a href={link.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:underline">{link.label} · {link.title}</a>
                    ) : (
                      <span className="min-w-0 flex-1 truncate">{link.label} · {link.title}</span>
                    )}
                    {!link.derived && (
                      <button type="button" onClick={() => void detach(link)} aria-label="Detach" className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-1.5 rounded border border-border/70 px-2">
            <Search className="h-3 w-3 text-muted-foreground" />
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setPickerOpen(false);
                if (e.key === 'Enter' && shown[0]) void attach(shown[0]);
              }}
              placeholder="Attach a Jira task, to-do, Slack message…"
              className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none"
            />
          </div>
          <div className="mt-1 max-h-72 overflow-y-auto">
            {!candidates && <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</div>}
            {candidates && shown.length === 0 && <div className="px-2 py-2 text-xs text-muted-foreground">Nothing to attach.</div>}
            {shown.map((c) => {
              const Icon = ICONS[c.itemType] ?? Hash;
              const id = `${c.itemType}:${c.itemKey}`;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => void attach(c)}
                  disabled={busyKey !== null}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-60"
                >
                  {busyKey === id ? <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" /> : <Icon className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
                  <span className="flex-shrink-0 font-medium">{c.label}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
