import { authenticatedFetch } from '@/shared/api';

export type SessionWorkItem = {
  type: 'jira' | 'slack' | 'pr' | 'todo';
  key: string;
  label: string;
  title: string;
  status: string | null;
  url: string | null;
};

export type SessionCard = {
  id: string;
  title: string;
  topic: string | null;
  provider: string;
  model: string | null;
  createdAt: string;
  lastActivity: string;
  userTurns: number;
  firstPrompt: string | null;
  lastUser: { text: string; at: string | null } | null;
  lastAssistant: { text: string; at: string | null } | null;
  forkedFrom: string | null;
  workItems: SessionWorkItem[];
  match?: { in: 'title' | 'user' | 'assistant'; snippet: string };
};

export async function fetchSessionCards(projectId: string, query: string, signal?: AbortSignal): Promise<{ cards: SessionCard[]; total: number }> {
  const params = new URLSearchParams({ projectId, limit: query ? '60' : '48' });
  if (query) params.set('q', query);
  const response = await authenticatedFetch(`/api/session-overview?${params.toString()}`, { signal });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) throw new Error(body?.error?.message || `Could not load sessions (${response.status})`);
  return body.data;
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-5-5[1m]" → "Sonnet 5.5 1M". */
export function modelLabel(model: string | null): string | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  const match = lower.match(/(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/);
  const suffix = lower.endsWith('[1m]') ? ' 1M' : '';
  if (!match) return model;
  const family = match[1][0].toUpperCase() + match[1].slice(1);
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ''}${suffix}`;
}
