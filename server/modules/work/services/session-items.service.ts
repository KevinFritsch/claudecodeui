/**
 * Kvn: the Work items each session of a project is attached to (Jira task,
 * Slack message, PR, to-do), labelled for display, for the sessions overview.
 */
import { getSnapshot } from './snapshot.service.js';
import { linksService } from './links.service.js';
import type { SlackMention } from './slack.service.js';
import { todosService } from './todos.service.js';
import { getProjectConfig } from './work-config.service.js';

export type SessionWorkItem = {
  type: 'jira' | 'slack' | 'pr' | 'todo';
  key: string;
  label: string;
  title: string;
  status: string | null;
  url: string | null;
};

export async function workItemsBySession(projectPath: string): Promise<Map<string, SessionWorkItem[]>> {
  const result = new Map<string, SessionWorkItem[]>();
  const config = getProjectConfig(projectPath);
  if (!config) return result;
  const snapshot = (await getSnapshot(projectPath, config).catch(() => null))?.snapshot;
  const tasks = snapshot?.jira?.items ?? [];
  const prs = snapshot?.pullRequests?.items ?? [];
  const mentions = snapshot?.slack?.items ?? [];

  for (const link of linksService.list(projectPath)) {
    let item: SessionWorkItem;
    if (link.itemType === 'jira') {
      const task = tasks.find((t) => t.key === link.itemKey);
      item = { type: 'jira', key: link.itemKey, label: link.itemKey, title: task?.summary ?? link.itemKey, status: task?.status ?? null, url: task?.url ?? null };
    } else if (link.itemType === 'slack') {
      const mention = mentions.find((m) => m.id === link.itemKey) ?? linksService.meta<SlackMention>(projectPath, 'slack', link.itemKey);
      item = {
        type: 'slack', key: link.itemKey, label: mention ? `@${mention.author}` : 'Slack', title: mention?.text.slice(0, 160) ?? 'Slack message',
        status: mentions.some((m) => m.id === link.itemKey) ? 'waiting' : 'answered', url: mention?.permalink ?? null,
      };
    } else if (link.itemType === 'pr') {
      const [repo, number] = link.itemKey.split('#');
      const pr = prs.find((p) => p.repo === repo && String(p.id) === number);
      item = { type: 'pr', key: link.itemKey, label: `PR #${number}`, title: pr ? pr.title : `${repo} #${number}`, status: pr ? 'open' : 'closed', url: pr?.url ?? null };
    } else {
      const todo = todosService.get(Number(link.itemKey));
      item = { type: 'todo', key: link.itemKey, label: 'to-do', title: todo?.text ?? 'Deleted to-do', status: todo?.status ?? null, url: null };
    }
    const list = result.get(link.sessionId) ?? [];
    if (!list.some((existing) => existing.type === item.type && existing.key === item.key)) list.push(item);
    result.set(link.sessionId, list);
  }
  return result;
}
