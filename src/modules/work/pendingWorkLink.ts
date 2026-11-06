/**
 * Carries "this new chat is for that Work item" from the Work tab's
 * Start-session button to the moment the chat's first message creates the
 * session, which can be minutes later. Kept in sessionStorage so a reload in
 * between does not lose it.
 */

export type PendingWorkLink = {
  projectPath: string;
  itemType: 'jira' | 'todo' | 'slack';
  itemKey: string;
  /** Name given to the session once it exists, e.g. "jira: GOL-3581 Cashback ledger". */
  sessionName: string;
  /** The first words of the prefilled prompt; the session is only linked if its first message still starts with them. */
  matchPrefix: string;
  expiresAt: number;
};

const STORAGE_KEY = 'work:pendingLink';
const TTL_MS = 60 * 60_000;

export function setPendingWorkLink(link: Omit<PendingWorkLink, 'expiresAt'>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...link, expiresAt: Date.now() + TTL_MS }));
  } catch {
    /* storage unavailable: the session just won't be linked automatically */
  }
}

function normalize(text: string): string {
  return text.trim().split(/\s+/).join(' ').toLowerCase();
}

/**
 * Returns and clears the pending link when the newly created session belongs
 * to it: same project, and its first message (the session's initial name)
 * still starts with the prefilled prompt.
 */
export function consumePendingWorkLink(projectPath: string, sessionSummary: string | null | undefined): PendingWorkLink | null {
  let pending: PendingWorkLink | null = null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    pending = raw ? (JSON.parse(raw) as PendingWorkLink) : null;
  } catch {
    return null;
  }
  if (!pending) return null;
  if (pending.expiresAt < Date.now()) {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
  if (pending.projectPath !== projectPath) return null;
  if (!normalize(sessionSummary ?? '').startsWith(normalize(pending.matchPrefix))) return null;
  sessionStorage.removeItem(STORAGE_KEY);
  return pending;
}
