import { authenticatedFetch } from '@/shared/api';

export type WorkConfig = {
  enabled: boolean;
  name: string | null;
  jira: { projectKey: string; statuses: string[]; collapsedStatuses: string[]; actions: string[] } | null;
  bitbucket: { workspace: string; repos: string[] } | null;
  slack: { lookbackDays: number } | null;
  todos: boolean;
};

export type TodoStatus = 'open' | 'done' | 'cancelled';

export type Todo = {
  id: number;
  projectPath: string;
  text: string;
  status: TodoStatus;
  createdAt: string;
  closedAt: string | null;
};

export type JiraTask = {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  issueType: string;
  priority: string | null;
  updated: string;
  url: string;
  sprint: { name: string; state: 'active' | 'future' } | null;
  carriedOverSprints: number;
};

export type PullRequest = {
  repo: string;
  id: number;
  title: string;
  url: string;
  author: string;
  isMine: boolean;
  sourceBranch: string;
  destinationBranch: string;
  issueKeys: string[];
  commentCount: number;
  taskCount: number;
  approvals: number;
  reviewers: Array<{ name: string; approved: boolean }>;
  createdOn: string;
  updatedOn: string;
  draft: boolean;
};

export type SlackMention = {
  id: string;
  channelId: string;
  channelName: string;
  channelKind: 'channel' | 'private' | 'dm' | 'group';
  ts: string;
  threadTs: string;
  author: string;
  authorId: string | null;
  authorAvatar: string | null;
  text: string;
  permalink: string;
  myReactions: string[];
  replyCount: number;
};

export type WorkLink = {
  itemType: 'jira' | 'todo' | 'slack' | 'pr';
  itemKey: string;
  sessionId: string;
  sessionName: string | null;
  createdAt: string;
};

export type SessionLinkView = {
  itemType: WorkLink['itemType'];
  itemKey: string;
  label: string;
  title: string;
  url: string | null;
  status: string | null;
  derived: boolean;
};

export type SourceResult<T> = { items: T; error: string | null; fetchedAt: string };

export type WorkItems = {
  todos: Todo[] | null;
  links: WorkLink[];
  jira: SourceResult<JiraTask[]> | null;
  pullRequests: SourceResult<PullRequest[]> | null;
  slack: SourceResult<SlackMention[]> | null;
  /** Mentions the user set aside on the dashboard (still open in Slack). */
  slackResolved: SlackMention[];
  /** When the server last finished loading Jira, Bitbucket and Slack. */
  fetchedAt: string;
  /** True while the server is reloading them in the background. */
  refreshing: boolean;
  /** "slack:<id>" / "jira:<key>" not seen before this load. */
  newKeys: string[];
  /** Every key that can be new, to mark as seen once shown. */
  currentKeys: string[];
};

async function request<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await authenticatedFetch(url, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const payload = await response.json().catch(() => null) as { success?: boolean; data?: T; error?: { message?: string } | string; message?: string } | null;
  if (!response.ok || !payload || payload.success === false) {
    const err = payload?.error;
    const message = (typeof err === 'string' ? err : err?.message) || payload?.message || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload.data as T;
}

const q = (projectPath: string) => `projectPath=${encodeURIComponent(projectPath)}`;

export const workApi = {
  config: (projectPath: string) => request<WorkConfig>(`/api/work/config?${q(projectPath)}`),
  items: (projectPath: string, refresh = false) =>
    request<WorkItems>(`/api/work/items?${q(projectPath)}${refresh ? '&refresh=1' : ''}`),
  createTodo: (projectPath: string, text: string) =>
    request<Todo>('/api/work/todos', { method: 'POST', body: { projectPath, text } }),
  updateTodo: (id: number, changes: { text?: string; status?: TodoStatus }) =>
    request<Todo>(`/api/work/todos/${id}`, { method: 'PATCH', body: changes }),
  deleteTodo: (id: number) => request<{ deleted: boolean }>(`/api/work/todos/${id}`, { method: 'DELETE' }),
  sessionLinks: (projectPath: string, sessionId: string) =>
    request<{ links: SessionLinkView[] }>(`/api/work/session-links?${q(projectPath)}&sessionId=${encodeURIComponent(sessionId)}`),
  link: (projectPath: string, itemType: WorkLink['itemType'], itemKey: string, sessionId: string) =>
    request<{ linked: boolean }>('/api/work/links', { method: 'POST', body: { projectPath, itemType, itemKey, sessionId } }),
  unlink: (projectPath: string, itemType: WorkLink['itemType'], itemKey: string, sessionId: string) =>
    request<{ linked: boolean }>('/api/work/links', { method: 'DELETE', body: { projectPath, itemType, itemKey, sessionId } }),
  resolve: (projectPath: string, itemType: WorkLink['itemType'], itemKeys: string[], resolved: boolean) =>
    request<{ count: number; resolved: boolean }>('/api/work/resolve', { method: 'POST', body: { projectPath, itemType, itemKeys, resolved } }),
  slackDone: (projectPath: string, id: string, done: boolean) =>
    request<{ id: string; done: boolean }>('/api/work/slack/done', { method: 'POST', body: { projectPath, id, done } }),
  slackAiReply: (projectPath: string, id: string, threadTs: string, author: string, instruction: string) =>
    request<{ text: string }>('/api/work/slack/ai-reply', { method: 'POST', body: { projectPath, id, threadTs, author, instruction } }),
  slackReply: (projectPath: string, id: string, threadTs: string, text: string) =>
    request<{ id: string; ts: string }>('/api/work/slack/reply', { method: 'POST', body: { projectPath, id, threadTs, text } }),
  badge: (projectPath: string) => request<{ count: number }>(`/api/work/badge?${q(projectPath)}`),
  markSeen: (projectPath: string, keys: string[]) =>
    request<{ count: number }>('/api/work/seen', { method: 'POST', body: { projectPath, keys } }),
  transition: (projectPath: string, key: string, to: string) =>
    request<{ key: string; from: string; to: string }>(`/api/work/jira/${encodeURIComponent(key)}/transition`, {
      method: 'POST',
      body: { projectPath, to },
    }),
};
